// Uploading what the field collected, when there is finally a signal.
//
// Everything is already durable before this runs (localSampleStore). This is the
// part that may fail, and it is written so that failing is ordinary:
//
//   • photographs are uploaded ONE AT A TIME and recorded as they land, so a
//     link that dies halfway does not re-send the megabytes that already made
//     it — on a field connection, dying halfway is the normal case;
//   • the submission carries the device's own id, so a retry after a timeout
//     cannot create a second sample. That is the difference between a queue and
//     a duplicate machine;
//   • it never throws at the caller. A sample that cannot be filed yet stays
//     queued, and the collection says so.
//
// The ANALYSIS needs no orchestration here: the server starts it on create
// (enterprise-samples → triggerAnalysis), so once the submission lands the
// result arrives on its own and the collection picks it up on the next read.
import type { LocalSampleStore } from "./localSampleStore";
import type { MediaRole, NewSampleInput, SampleMediaInput } from "../enterpriseSamples";

export interface SamplePushResult {
  attempted: number;
  uploaded: number;
  failed: number;
  blocked: "offline" | null;
}

export interface SampleSyncDeps {
  uploadPhoto: (uri: string, role: MediaRole) => Promise<SampleMediaInput>;
  submit: (input: NewSampleInput & { client_local_id: string }) => Promise<{ sample_id: string }>;
}

/** How many samples one drain will attempt. Photographs are large. */
export const MAX_PER_DRAIN = 3;

/**
 * The real API, loaded at the moment it is used and not before.
 *
 * `lib/enterpriseSamples` builds a network client at import time and throws
 * without configuration. This module is reachable from the offline field
 * workspace, so touching it eagerly would make an offline screen depend on the
 * network layer being constructible — the same fault as lib/sync/pushOutbox had.
 *
 * Resolved per CALL, and only for the dependency that was not supplied: a fully
 * injected caller (a test, or a future queue with its own transport) must not
 * load the network layer at all.
 */
function realApi(): {
  uploadSampleMedia: SampleSyncDeps["uploadPhoto"];
  submitSample: SampleSyncDeps["submit"];
} {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../enterpriseSamples");
}

export async function pushPendingSamples(
  store: LocalSampleStore,
  isOnline: boolean,
  deps?: Partial<SampleSyncDeps>,
): Promise<SamplePushResult> {
  const empty: SamplePushResult = { attempted: 0, uploaded: 0, failed: 0, blocked: null };
  if (!isOnline) return { ...empty, blocked: "offline" };

  await store.load();
  const due = store.pending().slice(0, MAX_PER_DRAIN);
  if (due.length === 0) return empty;

  const api: SampleSyncDeps = {
    uploadPhoto: deps?.uploadPhoto ?? ((uri, role) => realApi().uploadSampleMedia(uri, role)),
    submit: deps?.submit ?? ((input) => realApi().submitSample(input)),
  };
  let uploaded = 0, failed = 0;

  for (const sample of due) {
    try {
      await store.markUploading(sample.localId);

      // Photographs first, one at a time, each recorded the moment it lands.
      const media: SampleMediaInput[] = [];
      for (let i = 0; i < sample.photos.length; i++) {
        const p = sample.photos[i];
        if (p.storagePath) { media.push({ role: p.role, storage_path: p.storagePath }); continue; }
        const result = await api.uploadPhoto(p.localUri, p.role);
        await store.markPhotoUploaded(sample.localId, i, result.storage_path);
        media.push(result);
      }

      const { sample_id } = await api.submit({
        ...sample.payload,
        media,
        // The idempotency key. The server upserts on it, so this call is safe to
        // repeat after an unknown outcome — which is what a timeout is.
        client_local_id: sample.localId,
      });

      await store.markUploaded(sample.localId, sample_id);
      uploaded++;
    } catch (err) {
      const message = err instanceof Error ? err.message : "upload failed";
      await store.markFailed(sample.localId, message);
      failed++;
    }
  }

  return { attempted: due.length, uploaded, failed, blocked: null };
}

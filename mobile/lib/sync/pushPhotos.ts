// Driving the photo queue against the real server.
//
// Split from PhotoUploadQueue for the same reason pushOutbox is split from
// Outbox: the queue is a durable state machine that can be reasoned about and
// tested with no network, and this is the part that knows about tokens, edge
// functions and being offline. Mixing them would make the queue untestable and
// this file the only place the "lose no evidence" rule lived.
//
// NEVER THROWS at the caller. A field sync loop that can be broken by a bad
// response is a sync loop that stops running, and a queue that stops draining is
// evidence that never arrives.
import { supabase } from "../supabase";
import {
  createFileSystemPut, PermanentRefusal, type PhotoUploadQueue,
} from "./photoUploadQueue";

/**
 * Statuses that mean the server REFUSED, not that it failed.
 *
 * 401/403 — this account may not upload, or the mission belongs to someone else.
 * 400     — the request itself is malformed; sending it again is pointless.
 *
 * Everything else, including 503 "storage not configured", stays retryable: an
 * operator setting a secret is exactly the kind of thing that comes right on its
 * own, and the photographs should be waiting when it does.
 */
const REFUSAL_STATUSES = new Set([400, 401, 403]);

/** Matches the r2-presign function's response. */
interface PresignResponse {
  items?: Array<{ photoId: string; key: string; url: string }>;
  error?: string;
  missing?: string[];
  detail?: string;
}

export interface PushPhotosResult {
  uploaded: number;
  failed: number;
  blocked: "offline" | "unauthenticated" | "unconfigured" | null;
  reason: string | null;
}

const EMPTY: PushPhotosResult = { uploaded: 0, failed: 0, blocked: null, reason: null };

export async function pushPhotos(
  queue: PhotoUploadQueue,
  isOnline: boolean,
  deps: {
    put?: ReturnType<typeof createFileSystemPut>;
    invoke?: (missionId: string, photos: Array<{ photoId: string; contentType: string }>) =>
      Promise<PresignResponse>;
    /** Where the bytes landed, so the observation can record it. */
    onUploaded?: (photoId: string, r2Key: string) => void | Promise<void>;
  } = {},
): Promise<PushPhotosResult> {
  if (!isOnline) return { ...EMPTY, blocked: "offline", reason: "no connection" };

  await queue.load();
  if (queue.due().length === 0) return EMPTY;

  const invoke = deps.invoke ?? (async (missionId, photos) => {
    // The user's own JWT: the function re-verifies it and geo.claim_mission
    // decides whether this caller may write into that mission's prefix.
    const { data, error } = await supabase.functions.invoke("r2-presign/upload", {
      body: { missionId, photos },
    });
    if (error) {
      // The status, not the message. supabase-js gives every non-2xx the same
      // generic text ("Edge Function returned a non-2xx status code"), so reading
      // the message would make a refusal and an outage indistinguishable — and
      // the queue's whole retry policy hangs on telling them apart.
      const status = (error as { context?: { status?: number } }).context?.status;
      if (status != null && REFUSAL_STATUSES.has(status)) {
        throw new PermanentRefusal(
          status === 403
            ? "this account is not enabled for field uploads, or the mission belongs to another user"
            : `the server refused the request (HTTP ${status})`,
          status,
        );
      }
      throw new Error(error.message);
    }
    return (data ?? {}) as PresignResponse;
  });

  let blocked: PushPhotosResult["blocked"] = null;
  let reason: string | null = null;

  try {
    const result = await queue.drain({
      presign: async (missionId, photos) => {
        const data = await invoke(missionId, photos);
        if (!data.items) {
          // 503 with `missing` means the operator has not set the R2 secrets. That
          // is not the device's fault and not a lost photograph: the entry stays
          // queued and the state is reported so the app can say why.
          if (data.missing || data.detail) {
            blocked = "unconfigured";
            reason = data.detail ?? `storage not configured: ${(data.missing ?? []).join(", ")}`;
          }
          throw new Error(reason ?? data.error ?? "no URLs returned");
        }
        return data.items;
      },
      put: deps.put ?? createFileSystemPut(),
      onUploaded: deps.onUploaded,
    });
    return { ...result, blocked, reason };
  } catch (e) {
    // The queue itself does not throw for upload failures, so anything arriving
    // here is a failure to even start — no client, no session.
    return {
      ...EMPTY,
      blocked: blocked ?? "unauthenticated",
      reason: reason ?? (e instanceof Error ? e.message : String(e)),
    };
  }
}

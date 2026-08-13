// Getting a photograph off the phone and into object storage, eventually.
//
//   LOCAL_PENDING_UPLOAD  →  UPLOADING  →  UPLOADED
//                    ↘  FAILED  ↗  (retried, with backoff, for ever)
//
// THE RULE THIS EXISTS TO KEEP: no evidence is ever lost. A geologist on a
// mountain with no signal takes a photograph of a vein, and that photograph must
// still be there tomorrow, and the day after, and after the process has been
// killed twice — until it is confirmed in R2. So nothing here deletes a failed
// entry, and nothing marks an upload done on the device's word alone.
//
// WHY A SEPARATE STORE FROM THE WAYPOINTS
//
// `lib/field/*` is Phase 1 territory and frozen: it owns the sensors, the session
// and the on-disk record of what was observed. Upload progress is not an
// observation, and threading a network state machine through the store that holds
// a geologist's field notes would put two unrelated failure modes in one file. So
// this keeps its own record, keyed on the photo id the waypoint store already
// assigned.
//
// WHAT COUNTS AS SUCCESS
//
// A 2xx from R2 for that exact object. Not "the request completed", not "no
// exception was thrown". An upload that returned 403 because the URL had expired
// used to be indistinguishable from one that worked, and the difference is a
// mission analysed against photographs that are not there.
import { retryDelayMs, type KeyValueAdapter } from "./outbox";

export const PHOTO_QUEUE_STORAGE_KEY = "sync.photoUploads.v1";
/** A mission's photos are presigned together; one round trip, not one per file. */
export const PRESIGN_BATCH = 25;
/**
 * Give up marking an entry as actively failing after this many tries.
 *
 * It stays queued and keeps retrying — this only changes what the UI calls it, so
 * a geologist can tell "not yet" from "something is wrong".
 */
export const FAILING_ATTEMPTS = 4;
/**
 * How many CONFIRMED-UPLOADED entries to keep for reference.
 *
 * This store is read into memory on every launch, so without a bound it grows for
 * the life of the install — a season of field work is thousands of photographs, and
 * the app has already been brought to its knees once by a JSON file that only ever
 * got bigger. Uploaded entries are kept only as recent history; the bytes are in
 * R2 and the rows are in Postgres.
 *
 * THE INVARIANT: pruning removes uploaded entries ONLY. An entry that has not
 * reached R2 is evidence, and evidence is never dropped to save space — if that
 * ever conflicts with the bound, the bound loses.
 */
export const KEEP_UPLOADED = 200;

/**
 * `blocked` is a REFUSAL, not a failure — and the difference is a field phone's
 * battery.
 *
 * A failure is retried for ever, on purpose: no signal, a dead URL, a process
 * killed mid-PUT are all things that come right on their own, and a photograph is
 * evidence nobody may throw away. But a refusal never comes right by waiting. The
 * server saying "this account may not upload" or "this mission belongs to someone
 * else" will say the same thing in fifteen minutes and in fifteen hours, and the
 * queue would keep asking — every backoff period, for the life of the install,
 * from a phone in a wadi with no charger.
 *
 * So a refusal stops the asking and keeps the photograph. The local file is
 * untouched, the entry stays in the queue, and `retry()` puts it back the moment
 * whatever caused the refusal is fixed.
 */
export type PhotoUploadState = "pending" | "uploading" | "uploaded" | "failed" | "blocked";

/** One mission's photographs, one number per state. See `countsFor`. */
export type PhotoStateCounts = Record<PhotoUploadState, number>;

/**
 * Thrown by a `presign` implementation when the server REFUSED, rather than
 * failed.
 *
 * The queue cannot tell the two apart from an error message, and guessing from
 * message text is how a transient outage gets misread as a permanent one and a
 * geologist's photographs quietly stop trying.
 */
export class PermanentRefusal extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "PermanentRefusal";
  }
}

export interface PhotoUpload {
  photoId: string;
  missionId: string;
  /** The app-owned local copy. Still the source of truth until R2 confirms. */
  localUri: string;
  contentType: string;
  /** The object key, once the server has told us what it will be. */
  r2Key: string | null;
  state: PhotoUploadState;
  attempts: number;
  lastAttemptAt: number | null;
  lastError: string | null;
  uploadedAt: number | null;
  bytes: number | null;
}

/** What the queue needs from the outside world, all injected so tests need none of it. */
export interface UploadDeps {
  /** Ask the server for URLs. One call per mission per drain. */
  presign: (missionId: string, photos: Array<{ photoId: string; contentType: string }>) =>
    Promise<Array<{ photoId: string; key: string; url: string }>>;
  /** PUT the file. Returns the HTTP status and, when known, the byte count. */
  put: (url: string, localUri: string, contentType: string) =>
    Promise<{ status: number; bytes?: number }>;
  /**
   * Called once per photograph that reaches storage, with the key it landed on.
   *
   * The queue knows where every byte went and the waypoint that produced the
   * photograph did not — `remotePath` has been null on every record since the
   * field was added. A geologist reopening an observation could not tell whether
   * its photographs had left the phone. Optional, so the queue stays testable and
   * usable with nothing wired to it.
   */
  onUploaded?: (photoId: string, r2Key: string) => void | Promise<void>;
  now?: () => number;
}

function createAsyncStorageAdapter(): KeyValueAdapter {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const AsyncStorage = require("@react-native-async-storage/async-storage").default;
  return {
    getItem: (k: string) => AsyncStorage.getItem(k),
    setItem: (k: string, v: string) => AsyncStorage.setItem(k, v),
  };
}

type Listener = () => void;

export class PhotoUploadQueue {
  private items: PhotoUpload[] = [];
  private loaded = false;
  private readonly storage: KeyValueAdapter;
  private readonly now: () => number;
  private readonly listeners = new Set<Listener>();
  private writes: Promise<void> = Promise.resolve();
  /** One drain at a time, or two passes would presign and PUT the same file twice. */
  private draining = false;

  constructor(deps: { storage?: KeyValueAdapter; now?: () => number } = {}) {
    this.storage = deps.storage ?? createAsyncStorageAdapter();
    this.now = deps.now ?? Date.now;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await this.storage.getItem(PHOTO_QUEUE_STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      this.items = Array.isArray(parsed) ? (parsed as PhotoUpload[]) : [];
    } catch {
      this.items = [];
    }
    // An entry stuck in "uploading" means the process died mid-PUT. It is put back
    // to pending rather than left alone: the alternative is a photograph that
    // never retries and never uploads, which is exactly the loss this file exists
    // to prevent.
    let revived = 0;
    for (const it of this.items) {
      if (it.state === "uploading") { it.state = "pending"; revived++; }
    }
    this.loaded = true;
    if (revived > 0) await this.persist();
    this.notify();
  }

  all(): readonly PhotoUpload[] {
    return this.items;
  }

  /**
   * Drop the oldest confirmed uploads, and nothing else.
   *
   * Called after every write. Entries that are pending, uploading or failed are
   * untouchable however many there are: a bound that could discard a photograph
   * still on the phone would defeat the purpose of the whole file.
   */
  private prune(): void {
    const uploaded = this.items.filter((i) => i.state === "uploaded");
    if (uploaded.length <= KEEP_UPLOADED) return;
    // Oldest first by the moment R2 confirmed them.
    uploaded.sort((a, b) => (a.uploadedAt ?? 0) - (b.uploadedAt ?? 0));
    const drop = new Set(uploaded.slice(0, uploaded.length - KEEP_UPLOADED).map((i) => i.photoId));
    this.items = this.items.filter((i) => !drop.has(i.photoId));
  }

  /**
   * Queue a mission's photographs. Idempotent on photo id.
   *
   * Re-queueing something already uploaded does nothing — a finished section that
   * is retried must not re-upload what is already in R2.
   */
  async enqueue(
    missionId: string,
    photos: ReadonlyArray<{ id: string; uri: string; contentType?: string }>,
  ): Promise<void> {
    await this.load();
    for (const p of photos) {
      const existing = this.items.find((x) => x.photoId === p.id);
      if (existing) continue;
      this.items.push({
        photoId: p.id,
        missionId,
        localUri: p.uri,
        contentType: p.contentType ?? "image/jpeg",
        r2Key: null,
        state: "pending",
        attempts: 0,
        lastAttemptAt: null,
        lastError: null,
        uploadedAt: null,
        bytes: null,
      });
    }
    await this.persist();
  }

  /** Entries ready to try now: never-tried, or past their backoff. */
  due(at = this.now()): PhotoUpload[] {
    return this.items.filter((it) => {
      if (it.state === "uploaded" || it.state === "uploading") return false;
      // A refusal is not due. Ever — until something clears it.
      if (it.state === "blocked") return false;
      if (it.lastAttemptAt == null) return true;
      return at - it.lastAttemptAt >= retryDelayMs(it.attempts);
    });
  }

  /** Photographs the server refused, with the reason it gave. */
  blockedFor(missionId: string): PhotoUpload[] {
    return this.items.filter((it) => it.missionId === missionId && it.state === "blocked");
  }

  /**
   * Put refused photographs back in the queue.
   *
   * For when the cause is fixed — the account is enabled, the mission claim is
   * sorted out. Attempts are reset so the first retry is immediate: the geologist
   * has just done something about it and should not wait out a backoff earned by
   * a refusal that no longer applies.
   */
  async retryBlocked(missionId?: string): Promise<number> {
    await this.load();
    let n = 0;
    for (const it of this.items) {
      if (it.state !== "blocked") continue;
      if (missionId && it.missionId !== missionId) continue;
      it.state = "pending";
      it.attempts = 0;
      it.lastAttemptAt = null;
      n++;
    }
    if (n > 0) await this.persist();
    return n;
  }

  pendingFor(missionId: string): PhotoUpload[] {
    return this.items.filter((it) => it.missionId === missionId && it.state !== "uploaded");
  }

  /**
   * One mission's photographs, counted by what is actually happening to them.
   *
   * `pendingFor` answers "not uploaded", which is four different situations
   * wearing one number. A geologist read "UPLOADING 7" for forty-five minutes
   * while nothing was uploading and nothing ever would: every screen in the app
   * had only that number, so a refusal and a first attempt looked identical and
   * the reason — recorded on each entry as `lastError` — was displayed nowhere.
   *
   * `pending` and `uploading` resolve on their own. `failed` retries on a backoff
   * that caps at ten minutes. `blocked` never retries: `due()` skips it until
   * something calls `retryNow`. Telling a geologist which of the four they are
   * looking at is the difference between waiting and doing something.
   */
  countsFor(missionId: string): PhotoStateCounts {
    const c: PhotoStateCounts = { pending: 0, uploading: 0, uploaded: 0, failed: 0, blocked: 0 };
    for (const it of this.items) if (it.missionId === missionId) c[it.state] += 1;
    return c;
  }

  /**
   * Try this mission's stalled photographs again, now.
   *
   * Covers BOTH resting states, because the geologist pressing it means one
   * thing — "go on then" — and should not have to know that a refusal and a
   * failure are different inside. Attempts reset so the first try is immediate:
   * they have just done something about the cause, and making them sit out a
   * ten-minute backoff earned by the old cause would be its own bug.
   */
  async retryNow(missionId?: string): Promise<number> {
    await this.load();
    let n = 0;
    for (const it of this.items) {
      if (it.state !== "failed" && it.state !== "blocked") continue;
      if (missionId && it.missionId !== missionId) continue;
      it.state = "pending";
      it.attempts = 0;
      it.lastAttemptAt = null;
      n++;
    }
    if (n > 0) await this.persist();
    return n;
  }

  /**
   * Is every photograph of this mission confirmed in storage?
   *
   * The gate on sending a package for analysis. A mission with no photographs
   * returns true, which is correct: "I went there and there was nothing to
   * photograph" is a real finding, and it should not wait for ever.
   */
  allUploaded(missionId: string): boolean {
    return this.pendingFor(missionId).length === 0;
  }

  keyFor(photoId: string): string | null {
    return this.items.find((it) => it.photoId === photoId)?.r2Key ?? null;
  }

  stats(at = this.now()): {
    pending: number; uploading: number; uploaded: number;
    failing: number; blocked: number; due: number;
  } {
    return {
      pending: this.items.filter((i) => i.state === "pending").length,
      uploading: this.items.filter((i) => i.state === "uploading").length,
      uploaded: this.items.filter((i) => i.state === "uploaded").length,
      failing: this.items.filter((i) => i.state === "failed" && i.attempts >= FAILING_ATTEMPTS).length,
      // Reported separately from `failing`: one is waiting for the world to come
      // back, the other is waiting for a person to do something.
      blocked: this.items.filter((i) => i.state === "blocked").length,
      due: this.due(at).length,
    };
  }

  /**
   * Upload everything that is due, mission by mission.
   *
   * Returns what happened, so a caller can log or surface it. Never throws for a
   * failed upload: a failure is an ordinary outcome in the field, and it stays
   * queued.
   */
  async drain(deps: UploadDeps): Promise<{ uploaded: number; failed: number }> {
    await this.load();
    if (this.draining) return { uploaded: 0, failed: 0 };
    this.draining = true;
    const now = deps.now ?? this.now;
    let uploaded = 0, failed = 0;

    try {
      const due = this.due(now());
      // Group by mission so presigning is one request per mission, not per file.
      const byMission = new Map<string, PhotoUpload[]>();
      for (const it of due) {
        let g = byMission.get(it.missionId);
        if (!g) { g = []; byMission.set(it.missionId, g); }
        g.push(it);
      }

      for (const [missionId, group] of byMission) {
        for (let i = 0; i < group.length; i += PRESIGN_BATCH) {
          const batch = group.slice(i, i + PRESIGN_BATCH);
          let urls: Array<{ photoId: string; key: string; url: string }>;
          try {
            urls = await deps.presign(
              missionId,
              batch.map((b) => ({ photoId: b.photoId, contentType: b.contentType })),
            );
          } catch (e) {
            if (e instanceof PermanentRefusal) {
              // The server did not fail, it REFUSED. Retrying cannot change that,
              // and a queue that keeps asking is a queue that flattens a field
              // phone's battery over days for an answer that will not move.
              for (const b of batch) {
                b.state = "blocked";
                b.lastError = e.message;
                b.lastAttemptAt = now();
              }
              failed += batch.length;
              await this.persist();
              continue;
            }
            // Presigning failed — no network, or storage is unconfigured. The whole
            // batch is marked failed and retried later. Nothing is dropped.
            for (const b of batch) this.markFailed(b, message(e), now());
            failed += batch.length;
            await this.persist();
            continue;
          }

          const byId = new Map(urls.map((u) => [u.photoId, u]));
          for (const entry of batch) {
            const signed = byId.get(entry.photoId);
            if (!signed) {
              this.markFailed(entry, "server returned no URL for this photo", now());
              failed++;
              continue;
            }
            // Marked BEFORE the PUT, and persisted, so a process death mid-upload
            // is visible on the next load and revived rather than mistaken for
            // work already done.
            entry.state = "uploading";
            entry.r2Key = signed.key;
            entry.lastAttemptAt = now();
            entry.attempts += 1;
            await this.persist();

            try {
              const res = await deps.put(signed.url, entry.localUri, entry.contentType);
              if (res.status >= 200 && res.status < 300) {
                entry.state = "uploaded";
                entry.uploadedAt = now();
                entry.bytes = res.bytes ?? entry.bytes;
                entry.lastError = null;
                uploaded++;
                // Reported AFTER the state is set, and never allowed to fail the
                // upload: the bytes are in R2 either way, and a bookkeeping error
                // must not make a delivered photograph look undelivered.
                try {
                  if (entry.r2Key) await deps.onUploaded?.(entry.photoId, entry.r2Key);
                } catch { /* the upload stands */ }
              } else {
                // A non-2xx is a FAILURE. An expired URL returns 403, and treating
                // that as success would mean a mission analysed against
                // photographs that were never stored.
                this.markFailed(entry, `R2 returned ${res.status}`, now(), false);
                failed++;
              }
            } catch (e) {
              this.markFailed(entry, message(e), now(), false);
              failed++;
            }
            await this.persist();
          }
        }
      }
    } finally {
      this.draining = false;
    }

    this.notify();
    return { uploaded, failed };
  }

  private markFailed(entry: PhotoUpload, error: string, at: number, countAttempt = true): void {
    entry.state = "failed";
    entry.lastError = error;
    entry.lastAttemptAt = at;
    if (countAttempt) entry.attempts += 1;
    // r2Key is deliberately KEPT. It is the key the server will use next time, and
    // clearing it would make the record forget where the object was going.
  }

  private persist(): Promise<void> {
    this.writes = this.writes.then(async () => {
      this.prune();
      await this.storage.setItem(PHOTO_QUEUE_STORAGE_KEY, JSON.stringify(this.items));
      this.notify();
    });
    return this.writes;
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The real uploader: a presigned PUT straight to R2.
 *
 * `expo-file-system` streams the file rather than reading it into memory, which
 * matters — a field photograph is several megabytes and this runs on a phone that
 * is also drawing a map.
 */
export function createFileSystemPut(): UploadDeps["put"] {
  return async (url, localUri, contentType) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const FileSystem = require("expo-file-system");
    const info = await FileSystem.getInfoAsync(localUri);
    if (!info.exists) throw new Error(`local file is gone: ${localUri}`);
    const res = await FileSystem.uploadAsync(url, localUri, {
      httpMethod: "PUT",
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: { "Content-Type": contentType },
    });
    return { status: res.status, bytes: typeof info.size === "number" ? info.size : undefined };
  };
}

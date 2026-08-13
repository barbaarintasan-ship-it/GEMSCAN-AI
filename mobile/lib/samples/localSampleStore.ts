// Samples, on the device first.
//
// THE RULE (Architecture v2 §0.2): nothing collected in the field is ever
// discarded, and a missing signal is never an error the geologist has to handle.
// Today submitting a sample uploads its photographs, posts the record, and shows
// "Submission failed · try again" the moment either step cannot reach the
// server. In a wadi that is every time — and "try again" is advice the geologist
// cannot take.
//
// So the sample is written HERE first, completely: metadata, GPS, observations
// and the photographs themselves, copied into app-owned storage. Uploading is a
// separate concern that happens when there is a connection (see
// pendingSampleSync). A sample exists the moment it is taken.
//
// WHY THE PHOTOGRAPHS ARE COPIED
// ------------------------------
// The camera hands back URIs in the OS cache, which the platform may purge under
// storage pressure. A field photograph is unrepeatable once the geologist has
// walked away, so it is copied into documentDirectory — the same reasoning, and
// the same layout, as lib/field/waypointStore.ts.
//
// Dependency-free of react. The adapters are injected so the whole policy is
// testable without a device.
import type { MediaRole, NewSampleInput } from "../enterpriseSamples";

export interface KeyValueAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface PhotoFileAdapter {
  /** Copy a camera uri into app-owned storage; returns the local uri. */
  persist(sourceUri: string, fileName: string): Promise<string>;
  remove(uri: string): Promise<void>;
}

export interface PendingPhoto {
  role: MediaRole;
  /** App-owned copy. This is the record; the camera's cache is not. */
  localUri: string;
  /** Set once this photograph is in Storage, so a retry never re-uploads it. */
  storagePath: string | null;
}

/** Where a local sample has got to. */
export type LocalSampleState = "pending" | "uploading" | "uploaded" | "failed";

export interface LocalSample {
  /** The device's own id. Also the server-side idempotency key. */
  localId: string;
  serverId: string | null;
  state: LocalSampleState;
  /** What the ANALYSIS has done, as far as this device knows. */
  aiState: "pending" | "queued" | "done" | "failed";
  /** Everything except the media, which lives in `photos` until uploaded. */
  payload: Omit<NewSampleInput, "media">;
  photos: PendingPhoto[];
  /** The walk this belongs to (Slice 2), so the server can attribute it. */
  expeditionSessionId: string | null;
  /**
   * WHO COLLECTED THIS. Sealed at capture, on the device.
   *
   * Attribution used to happen at UPLOAD, from whichever token happened to
   * carry the request. Over a long offline expedition that is wrong and
   * silently so: sign out in the field, hand the phone to a colleague, and
   * their token files observations under their name that they never made.
   * For scientific data that is not a bug, it is a falsified record.
   *
   * Null only when no identity was known at capture. Never overwritten.
   */
  collectedBy: { userId: string; email: string | null } | null;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  lastError: string | null;
}

interface Envelope {
  version: 1;
  samples: LocalSample[];
}

export const LOCAL_SAMPLE_STORAGE_KEY = "enterprise.samples.local.v1";

/** Uploaded samples kept on the device, so the collection reads offline. */
export const KEEP_UPLOADED = 200;

/**
 * How long an upload that failed waits before it is tried again.
 *
 * Doubling from thirty seconds, capped at fifteen minutes. A sample carries
 * megabytes of photographs; retrying that on a hot loop over a weak link is how
 * a phone's battery disappears before the traverse ends.
 */
export const RETRY_BASE_MS = 30_000;
export const RETRY_MAX_MS = 900_000;

export function retryDelayMs(attempts: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

function createAsyncStorageAdapter(): KeyValueAdapter {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const AsyncStorage = require("@react-native-async-storage/async-storage").default;
  return {
    getItem: (k: string) => AsyncStorage.getItem(k),
    setItem: (k: string, v: string) => AsyncStorage.setItem(k, v),
  };
}

function createFileSystemPhotoAdapter(): PhotoFileAdapter {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const FileSystem = require("expo-file-system");
  // documentDirectory, not cacheDirectory: the OS may purge the cache under
  // storage pressure, and a field photograph is unrepeatable once the geologist
  // has walked away. Matches lib/field/waypointStore.ts.
  const dir = (FileSystem.documentDirectory ?? "") + "enterprise/pending-samples/";
  const ensureDir = async (): Promise<void> => {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  };
  return {
    async persist(sourceUri: string, fileName: string) {
      await ensureDir();
      const to = dir + fileName;
      await FileSystem.copyAsync({ from: sourceUri, to });
      return to;
    },
    async remove(uri: string) {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    },
  };
}

type Listener = () => void;

export class LocalSampleStore {
  private samples: LocalSample[] = [];
  private storage: KeyValueAdapter;
  private files: PhotoFileAdapter;
  private now: () => number;
  private loaded = false;
  /** The single in-flight read, shared by every caller. */
  private loading: Promise<void> | null = null;
  private listeners = new Set<Listener>();
  private seq = 0;
  private writing: Promise<void> = Promise.resolve();

  constructor(deps: {
    storage?: KeyValueAdapter;
    files?: PhotoFileAdapter;
    now?: () => number;
  } = {}) {
    this.storage = deps.storage ?? createAsyncStorageAdapter();
    this.files = deps.files ?? createFileSystemPhotoAdapter();
    this.now = deps.now ?? (() => Date.now());
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /**
   * Read storage once, and make every caller wait for the SAME read.
   *
   * THE BUG THIS FIXES, because it cost an expedition. `loaded` was set to true
   * BEFORE the await, so the second caller in a tick saw `true` and returned from
   * a read that had not finished — with the collection still empty. In the app the
   * route's hook always won that race and the exploration provider always lost, so
   * the stored lease was invisible at startup and a walk interrupted by a process
   * kill could not be resumed: the phone had the lease on disk and reported no
   * expedition. Four launches in a row, reproducible.
   *
   * The same shape was in five stores, and in three of them it is worse than a
   * lost lease: `add()` awaits `load()` and then persists, so a write landing
   * inside that window would have overwritten every unsent record on disk with
   * one entry. That is the byte-loss path the Field Reliability Contract exists to
   * forbid, and it was reachable.
   *
   * `loaded` is now set in a `finally` after the read genuinely completes, and the
   * in-flight promise is shared.
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loading ??= this.readOnce();
    await this.loading;
  }

  private async readOnce(): Promise<void> {
    try {
      const raw = await this.storage.getItem(LOCAL_SAMPLE_STORAGE_KEY);
      if (!raw) return;
      const env = JSON.parse(raw) as Envelope;
      if (env?.version === 1 && Array.isArray(env.samples)) {
        this.samples = env.samples.filter((x) => typeof x?.localId === "string");
      }
    } catch {
      // An unreadable store must not stop the sample about to be taken.
    } finally {
      this.loaded = true;
      this.emit();
    }
  }

  all(): readonly LocalSample[] {
    return this.samples;
  }

  /** Everything the server has not accepted yet, oldest first. */
  pending(at = this.now()): LocalSample[] {
    return this.samples
      .filter((x) => x.state === "pending" || x.state === "failed")
      .filter((x) => x.attempts === 0 || at - x.updatedAt >= retryDelayMs(x.attempts))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  get(localId: string): LocalSample | undefined {
    return this.samples.find((x) => x.localId === localId);
  }

  /**
   * Record a sample, photographs and all.
   *
   * Returns as soon as it is durable. There is no network in this path at all,
   * which is the point: the geologist is told "saved", not "failed".
   */
  async create(input: {
    payload: Omit<NewSampleInput, "media">;
    photos: Array<{ uri: string; role: MediaRole }>;
    expeditionSessionId?: string | null;
    collectedBy?: { userId: string; email: string | null } | null;
  }): Promise<LocalSample> {
    await this.load();
    const t = this.now();
    const localId = `smp-${t.toString(36)}-${++this.seq}`;

    const photos: PendingPhoto[] = [];
    for (let i = 0; i < input.photos.length; i++) {
      const p = input.photos[i];
      let localUri = p.uri;
      try {
        localUri = await this.files.persist(p.uri, `${localId}-${i}-${p.role}.jpg`);
      } catch {
        // The copy failed — keep the original uri rather than losing the
        // photograph. It may still be readable when the upload runs.
      }
      photos.push({ role: p.role, localUri, storagePath: null });
    }

    const sample: LocalSample = {
      localId,
      serverId: null,
      state: "pending",
      aiState: "pending",
      payload: input.payload,
      photos,
      expeditionSessionId: input.expeditionSessionId ?? null,
      collectedBy: input.collectedBy ?? null,
      createdAt: t,
      updatedAt: t,
      attempts: 0,
      lastError: null,
    };
    this.samples.push(sample);
    await this.persist();
    return sample;
  }

  /** Edit a sample that has not been accepted yet. Offline editing, §"searchable, editable". */
  async update(localId: string, patch: Partial<Omit<NewSampleInput, "media">>): Promise<void> {
    await this.load();
    const s = this.get(localId);
    if (!s) return;
    s.payload = { ...s.payload, ...patch };
    s.updatedAt = this.now();
    await this.persist();
  }

  async markUploading(localId: string): Promise<void> {
    const s = this.get(localId);
    if (!s) return;
    s.state = "uploading";
    await this.persist();
  }

  /** One photograph reached Storage. Recorded immediately so a retry skips it. */
  async markPhotoUploaded(localId: string, index: number, storagePath: string): Promise<void> {
    const s = this.get(localId);
    if (!s || !s.photos[index]) return;
    s.photos[index].storagePath = storagePath;
    s.updatedAt = this.now();
    await this.persist();
  }

  async markUploaded(localId: string, serverId: string): Promise<void> {
    const s = this.get(localId);
    if (!s) return;
    s.serverId = serverId;
    s.state = "uploaded";
    // The server runs the analysis on create, so from here the device is
    // waiting for a result rather than for an upload.
    s.aiState = "queued";
    s.lastError = null;
    s.updatedAt = this.now();
    this.prune();
    await this.persist();
  }

  async markFailed(localId: string, error: string): Promise<void> {
    const s = this.get(localId);
    if (!s) return;
    s.state = "failed";
    s.attempts += 1;
    s.lastError = error.slice(0, 300);
    s.updatedAt = this.now();
    await this.persist();
  }

  /** The analysis result arrived (or failed) for an uploaded sample. */
  async setAiState(localId: string, aiState: LocalSample["aiState"]): Promise<void> {
    const s = this.get(localId);
    if (!s) return;
    s.aiState = aiState;
    s.updatedAt = this.now();
    await this.persist();
  }

  /** Remove a local record and its photographs. Used after a deliberate delete. */
  async remove(localId: string): Promise<void> {
    await this.load();
    const s = this.get(localId);
    if (!s) return;
    for (const p of s.photos) {
      // Only app-owned copies are ours to delete.
      if (p.localUri.includes("pending-samples")) await this.files.remove(p.localUri).catch(() => {});
    }
    this.samples = this.samples.filter((x) => x.localId !== localId);
    await this.persist();
  }

  stats(): { pending: number; failed: number; uploaded: number } {
    let pending = 0, failed = 0, uploaded = 0;
    for (const s of this.samples) {
      if (s.state === "uploaded") uploaded++;
      else if (s.state === "failed") failed++;
      else pending++;
    }
    return { pending, failed, uploaded };
  }

  /**
   * Forget the oldest UPLOADED records, and their photographs with them.
   *
   * Never a pending one: those are the only copy of a field observation. The
   * photographs of an uploaded sample are already in Storage, so the local copy
   * is a cache and may go.
   */
  private prune(): void {
    const uploaded = this.samples.filter((x) => x.state === "uploaded");
    if (uploaded.length <= KEEP_UPLOADED) return;
    const drop = uploaded
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, uploaded.length - KEEP_UPLOADED);
    const ids = new Set(drop.map((d) => d.localId));
    for (const d of drop) {
      for (const p of d.photos) {
        if (p.localUri.includes("pending-samples")) void this.files.remove(p.localUri).catch(() => {});
      }
    }
    this.samples = this.samples.filter((x) => !ids.has(x.localId));
  }

  private async persist(): Promise<void> {
    const env: Envelope = { version: 1, samples: this.samples };
    const write = this.writing.then(async () => {
      try {
        await this.storage.setItem(LOCAL_SAMPLE_STORAGE_KEY, JSON.stringify(env));
      } catch {
        // Still in memory; the next write may succeed.
      }
    });
    this.writing = write;
    await write;
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

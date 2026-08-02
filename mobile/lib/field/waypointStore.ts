// Field Exploration Engine — Waypoint persistence (Phase 2, Milestone 2.1).
//
// Offline-first by construction: the device is the source of truth, and every
// mutation lands on disk before anything else is attempted. Nothing here knows
// about the network — Milestone 2.5 reads `syncState` and drives uploads.
//
// Both side-effecting dependencies are injected behind narrow adapters, with
// the real ones required LAZILY (the Phase 1 AppState pattern), so the whole
// store is unit-testable without AsyncStorage or a filesystem.
import type { Waypoint } from "./waypointTypes";

export const WAYPOINT_STORAGE_KEY = "field.waypoints.v1";

interface Envelope {
  version: 1;
  waypoints: Waypoint[];
}

// ── Adapters ────────────────────────────────────────────────────────────────
export interface KeyValueAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface PhotoFileAdapter {
  /** Copy a picker/camera uri into app-owned storage; returns the local uri. */
  persist(sourceUri: string, fileName: string): Promise<string>;
  remove(uri: string): Promise<void>;
}

function createAsyncStorageAdapter(): KeyValueAdapter {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const AsyncStorage = require("@react-native-async-storage/async-storage").default;
  return {
    getItem: (k) => AsyncStorage.getItem(k),
    setItem: (k, v) => AsyncStorage.setItem(k, v),
  };
}

function createFileSystemPhotoAdapter(): PhotoFileAdapter {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const FileSystem = require("expo-file-system");
  // documentDirectory, not cacheDirectory: the OS may purge the cache under
  // storage pressure, and a field photo is unrepeatable once the geologist has
  // walked away. Matches lib/offlineCache.ts.
  const dir = (FileSystem.documentDirectory ?? "") + "field/waypoint-photos/";
  const ensureDir = async (): Promise<void> => {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  };
  return {
    async persist(sourceUri, fileName) {
      await ensureDir();
      const to = dir + fileName;
      await FileSystem.copyAsync({ from: sourceUri, to });
      return to;
    },
    async remove(uri) {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    },
  };
}

export interface WaypointStoreDeps {
  storage?: KeyValueAdapter;
  photos?: PhotoFileAdapter;
}

type Listener = () => void;

/**
 * In-memory index of every waypoint on the device, written through to disk.
 *
 * The in-memory list is authoritative for the running app: a failed disk write
 * is recorded, not thrown, and the next mutation rewrites the whole envelope —
 * so a transient storage error costs at most the moments until the next edit,
 * never the observation itself.
 */
export class WaypointStore {
  private storage: KeyValueAdapter;
  private photoFiles: PhotoFileAdapter;

  private waypoints: Waypoint[] = [];
  private listeners = new Set<Listener>();
  private hydrated = false;
  private hydrating: Promise<void> | null = null;
  private lastWriteFailed = false;
  private snapshotCache: readonly Waypoint[] | null = null;

  constructor(deps: WaypointStoreDeps = {}) {
    this.storage = deps.storage ?? createAsyncStorageAdapter();
    this.photoFiles = deps.photos ?? createFileSystemPhotoAdapter();
  }

  // ── Hydration ─────────────────────────────────────────────────────────────
  /** Idempotent and concurrency-safe: parallel callers share one read. */
  async load(): Promise<void> {
    if (this.hydrated) return;
    this.hydrating ??= this.readFromDisk().finally(() => { this.hydrating = null; });
    return this.hydrating;
  }

  private async readFromDisk(): Promise<void> {
    try {
      const raw = await this.storage.getItem(WAYPOINT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Envelope>;
        // An unrecognised envelope is kept on disk untouched rather than
        // overwritten — losing field data to a version mismatch is worse than
        // starting empty for the session.
        if (parsed.version === 1 && Array.isArray(parsed.waypoints)) {
          this.waypoints = parsed.waypoints;
        }
      }
    } catch {
      // Corrupt or unreadable: start empty rather than block the field screen.
    }
    this.hydrated = true;
    this.invalidate();
  }

  isHydrated(): boolean { return this.hydrated; }
  /** True when the last write-through did not reach disk. */
  hasPendingWriteFailure(): boolean { return this.lastWriteFailed; }

  // ── Reads ─────────────────────────────────────────────────────────────────
  /** Every record, tombstones included — sync needs the deletions. */
  all(): readonly Waypoint[] {
    this.snapshotCache ??= [...this.waypoints];
    return this.snapshotCache;
  }

  /** What the field screens show: live records, newest capture first. */
  visible(sessionId?: string): readonly Waypoint[] {
    return this.all()
      .filter((w) => w.deletedAt == null && (sessionId === undefined || w.sessionId === sessionId))
      .sort((a, b) => b.capturedAt - a.capturedAt);
  }

  get(id: string): Waypoint | null {
    return this.waypoints.find((w) => w.id === id) ?? null;
  }

  pendingSync(): readonly Waypoint[] {
    return this.all().filter((w) => w.syncState !== "synced");
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  // ── Writes ────────────────────────────────────────────────────────────────
  /** Insert or replace by id, then write through. */
  async put(waypoint: Waypoint): Promise<Waypoint> {
    const idx = this.waypoints.findIndex((w) => w.id === waypoint.id);
    if (idx >= 0) this.waypoints[idx] = waypoint;
    else this.waypoints.push(waypoint);
    await this.flush();
    return waypoint;
  }

  /** Soft delete: the tombstone is what tells the server to remove it too. */
  async softDelete(id: string, at: number): Promise<Waypoint | null> {
    const existing = this.get(id);
    if (!existing || existing.deletedAt != null) return null;
    return this.put({ ...existing, deletedAt: at, updatedAt: at, syncState: "local" });
  }

  /**
   * Drop tombstones the server has already accepted, and delete their photo
   * files. Called after a successful sync; never on the capture path.
   */
  async purgeSyncedDeletions(): Promise<number> {
    const gone = this.waypoints.filter((w) => w.deletedAt != null && w.syncState === "synced");
    if (gone.length === 0) return 0;
    this.waypoints = this.waypoints.filter((w) => !(w.deletedAt != null && w.syncState === "synced"));
    await Promise.all(
      gone.flatMap((w) => w.photos.map((p) => this.photoFiles.remove(p.uri).catch(() => {}))),
    );
    await this.flush();
    return gone.length;
  }

  /** Copy a camera/library uri into app-owned storage. */
  persistPhotoFile(sourceUri: string, fileName: string): Promise<string> {
    return this.photoFiles.persist(sourceUri, fileName);
  }

  removePhotoFile(uri: string): Promise<void> {
    return this.photoFiles.remove(uri);
  }

  private async flush(): Promise<void> {
    this.invalidate();
    const envelope: Envelope = { version: 1, waypoints: this.waypoints };
    try {
      await this.storage.setItem(WAYPOINT_STORAGE_KEY, JSON.stringify(envelope));
      this.lastWriteFailed = false;
    } catch {
      // The in-memory list stays authoritative; the next mutation rewrites the
      // whole envelope, so this self-heals without a retry loop.
      this.lastWriteFailed = true;
    }
  }

  private invalidate(): void {
    this.snapshotCache = null;
    for (const l of this.listeners) l();
  }
}

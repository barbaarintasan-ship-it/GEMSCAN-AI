// The expedition lease — what makes field work outlive a token.
//
// WHY THIS EXISTS. On 07–08/08/2026 a geologist drove 130 km into the Karkaar
// mountains, worked through the night with no signal, and was logged out
// mid-expedition. The access token lasts about an hour; the expedition lasted
// fourteen. `onAuthStateChange` propagated a null session, `(app)/_layout`
// redirected to a login screen, and signing in needs a network that does not
// exist out there. The app stopped work that required no identity at all —
// local map, local pack, local GPS, local storage.
//
// The lease is the record that says "a field session is open on this device".
// It is read BEFORE the router decides anything, so an expired token cannot
// eject anyone, and it is written to storage, so an Android process kill cannot
// either. Those are two different failures and the lease answers both.
//
// THREE THINGS THE LEASE SEPARATES, which the old design conflated:
//
//   ATTRIBUTION    who collected this. Sealed here, at open, locally. Survives
//                  logout, because history must not be rewritten by an account
//                  action.
//   AUTHENTICATION proving identity to a server. Needed only to UPLOAD.
//   AUTHORISATION  whether that identity may write to an org's data. Server-side,
//                  at upload.
//
// Field work needs the first. Only the last two need a network.
//
// DELIBERATELY NOT HERE: the expedition's data. The lease is a marker, not a
// store — the track, samples, waypoints and outbox already own their own durable
// storage. A lease that also held data would be a second source of truth for the
// same records, which is the defect this whole exercise is unwinding.
import type { KeyValueAdapter } from "../samples/localSampleStore";

/** Who was collecting when the lease opened. Sealed; never rewritten. */
export interface Collector {
  userId: string;
  email: string | null;
}

/**
 * Where a lease stands.
 *
 *   attached   an expedition is open and the account is signed in
 *   detached   an expedition is open and the account has been signed out
 *
 * `detached` is a first-class state rather than a side effect of a null session,
 * and that distinction is the whole point. "The token expired offline" and "the
 * geologist chose to sign out" produce the same null session and deserve
 * completely different words on screen. Naming it also means it can be tested;
 * an emergent behaviour cannot.
 */
export type LeaseState = "attached" | "detached";

export interface ExpeditionLease {
  /** The orchestrator's session id, so the lease and the walk are the same thing. */
  expeditionId: string;
  openedAt: number;
  /** Sealed at open. Null only when no identity was known — never overwritten. */
  collectedBy: Collector | null;
  /** Which build produced these records. Provenance, not telemetry. */
  build: string;
  state: LeaseState;
  /** When the account was signed out, if it was. */
  detachedAt: number | null;
}

export const LEASE_STORAGE_KEY = "exploration.lease.v1";

/**
 * How long an OPEN lease keeps lifting the auth gate.
 *
 * Not a limit on the expedition: only the geologist ends that (Field Reliability
 * Contract, clause 2). This is a safety net for a lease that was never closed —
 * a crash during teardown, a phone that died mid-traverse — so a forgotten lease
 * cannot hold the gate open for ever. Two weeks is far beyond any expedition
 * anyone has described, and a stale lease self-heals without touching the data
 * it refers to.
 */
export const MAX_LEASE_MS = 14 * 24 * 60 * 60 * 1000;

interface Envelope {
  version: 1;
  lease: ExpeditionLease | null;
}

/**
 * Why the last lease stopped existing, kept AFTER it is gone.
 *
 * `close()` used to set the lease to null and persist, leaving no trace. An
 * expedition then vanished between two builds and the honest answer to "what
 * happened to it?" was that nothing on the device knew — which is exactly the
 * silent failure the Field Reliability Contract forbids. A lease is the record
 * that a geologist was out collecting; it may not disappear anonymously.
 */
export interface LeaseClosure {
  expeditionId: string;
  openedAt: number;
  closedAt: number;
  /**
   * `ended`   the geologist ended the walk (the only ordinary reason).
   * `expired` it outlived MAX_LEASE_MS and stopped holding the gate.
   */
  reason: "ended" | "expired";
  build: string;
}

export const LEASE_CLOSURE_KEY = "exploration.lease.lastClose.v1";

function createAsyncStorageAdapter(): KeyValueAdapter {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const AsyncStorage = require("@react-native-async-storage/async-storage").default;
  return {
    getItem: (k: string) => AsyncStorage.getItem(k) as Promise<string | null>,
    setItem: (k: string, v: string) => AsyncStorage.setItem(k, v) as Promise<void>,
  };
}

type Listener = () => void;

export class ExpeditionLeaseStore {
  private lease: ExpeditionLease | null = null;
  private closure: LeaseClosure | null = null;
  private loaded = false;
  /** The single in-flight read, shared by every caller. */
  private loading: Promise<void> | null = null;
  private listeners = new Set<Listener>();
  private storage: KeyValueAdapter;
  private now: () => number;
  private buildOf: () => string;
  // Serialised, like the outbox: two writes in one tick must not lose one.
  private writing: Promise<void> = Promise.resolve();

  constructor(deps: {
    storage?: KeyValueAdapter;
    now?: () => number;
    build?: () => string;
  } = {}) {
    this.storage = deps.storage ?? createAsyncStorageAdapter();
    this.now = deps.now ?? (() => Date.now());
    this.buildOf = deps.build ?? defaultBuild;
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
      const raw = await this.storage.getItem(LEASE_STORAGE_KEY);
      if (raw) {
        const env = JSON.parse(raw) as Envelope;
        if (env?.version === 1 && isLease(env.lease)) this.lease = env.lease;
      }
      const closeRaw = await this.storage.getItem(LEASE_CLOSURE_KEY);
      if (closeRaw) {
        const c = JSON.parse(closeRaw) as LeaseClosure;
        if (typeof c?.expeditionId === "string" && typeof c.closedAt === "number") {
          this.closure = c;
        }
      }
    } catch {
      // An unreadable lease is the same as none: the gate applies and the
      // geologist signs in. Throwing here would take out the whole app at
      // startup, which is a far worse answer than asking for a password.
    } finally {
      this.loaded = true;
      this.emit();
    }
  }

  isLoaded(): boolean { return this.loaded; }

  /** The stored lease, whatever its age. */
  get(): ExpeditionLease | null { return this.lease; }

  /**
   * Whether a lease should currently lift the auth gate.
   *
   * This — not `get() !== null` — is what the router asks. A lease past
   * MAX_LEASE_MS is kept (its records still refer to it) but stops holding the
   * gate open.
   */
  isOpen(at = this.now()): boolean {
    if (!this.lease) return false;
    return at - this.lease.openedAt < MAX_LEASE_MS;
  }

  /** True when the account has been signed out but the expedition continues. */
  isDetached(): boolean {
    return this.lease?.state === "detached";
  }

  /**
   * Open a lease for a walk.
   *
   * Idempotent on the expedition id: a remount must not reseal attribution or
   * reset `openedAt`, or the lease would forget how long the geologist has been
   * out — and, worse, could reattribute records to whoever is signed in now.
   */
  async open(expeditionId: string, collectedBy: Collector | null): Promise<void> {
    await this.load();
    if (this.lease?.expeditionId === expeditionId) return;
    this.lease = {
      expeditionId,
      openedAt: this.now(),
      collectedBy,
      build: this.buildOf(),
      state: "attached",
      detachedAt: null,
    };
    await this.persist();
  }

  /**
   * The account signed out while the expedition is open.
   *
   * The lease is NOT closed and `collectedBy` is NOT cleared. Recording
   * continues; only the ability to upload as that account is gone. Clearing the
   * collector here would be the app rewriting the provenance of records already
   * taken, on the strength of an account action.
   */
  async detach(): Promise<void> {
    await this.load();
    if (!this.lease || this.lease.state === "detached") return;
    this.lease = { ...this.lease, state: "detached", detachedAt: this.now() };
    await this.persist();
  }

  /** Signing back in as the same collector re-attaches the open lease. */
  async reattach(): Promise<void> {
    await this.load();
    if (!this.lease || this.lease.state === "attached") return;
    this.lease = { ...this.lease, state: "attached", detachedAt: null };
    await this.persist();
  }

  /**
   * The geologist ended the expedition. The only ordinary way a lease closes.
   *
   * The closure is written BEFORE the lease is dropped, and it outlives it. If
   * the write of the closure fails the lease still closes: refusing to end a walk
   * because a diagnostic could not be saved would be the tail wagging the dog.
   */
  async close(reason: LeaseClosure["reason"] = "ended"): Promise<void> {
    await this.load();
    if (!this.lease) return;
    this.closure = {
      expeditionId: this.lease.expeditionId,
      openedAt: this.lease.openedAt,
      closedAt: this.now(),
      reason,
      build: this.buildOf(),
    };
    try {
      await this.storage.setItem(LEASE_CLOSURE_KEY, JSON.stringify(this.closure));
    } catch {
      // In memory for this session, which is still better than nothing: the
      // panel can answer for as long as the process lives.
    }
    this.lease = null;
    await this.persist();
  }

  /** How the last lease ended, or null if none has ever ended on this device. */
  lastClosure(): LeaseClosure | null { return this.closure; }

  private async persist(): Promise<void> {
    const env: Envelope = { version: 1, lease: this.lease };
    const write = this.writing.then(async () => {
      try {
        await this.storage.setItem(LEASE_STORAGE_KEY, JSON.stringify(env));
      } catch {
        // Out of storage, or the platform refused. The lease is still in memory,
        // so this session keeps working; a process kill would lose it and the
        // gate would apply again. Storage as a managed resource is Milestone 3 —
        // recorded here as a known gap rather than silently assumed away.
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

function isLease(v: unknown): v is ExpeditionLease {
  if (!v || typeof v !== "object") return false;
  const l = v as Partial<ExpeditionLease>;
  return typeof l.expeditionId === "string"
    && typeof l.openedAt === "number"
    && (l.state === "attached" || l.state === "detached");
}

function defaultBuild(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Constants = require("expo-constants").default;
    const c = Constants?.expoConfig;
    return c ? `${c.version ?? "?"} (${c.android?.versionCode ?? "?"})` : "unknown";
  } catch {
    return "unknown";
  }
}

// ── The app-wide instance ───────────────────────────────────────────────────
// A module singleton for the same reason lib/exploration/currentExpedition is
// one: the router, the root layout and the workspace live in different subtrees
// and all three need the same answer.
let instance: ExpeditionLeaseStore | null = null;

export function expeditionLease(): ExpeditionLeaseStore {
  instance ??= new ExpeditionLeaseStore();
  return instance;
}

/** Tests only — a fresh store with injected adapters. */
export function __setExpeditionLeaseForTests(s: ExpeditionLeaseStore | null): void {
  instance = s;
}

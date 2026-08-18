// The outbox — what the field collected, waiting for a signal.
//
// ARCHITECTURE V2, PRINCIPLE 0.2: *nothing collected in the field is ever
// discarded.* Today that is false. The exploration session id, the track and the
// waypoints live only on the device, and the walk ends when the screen does — a
// day of ground covered, and the platform learns nothing from it.
//
// This is the queue that fixes it. Every field record is appended here the
// moment it exists, on the device, with no network involved. Draining it is a
// separate concern that happens when there is a connection (see pushOutbox).
//
// FOUR PROPERTIES, and each one is there because of how field work actually goes:
//
//   1. DURABLE. Written to storage on every change. A phone that dies in a wadi
//      has already saved what it collected.
//   2. IDEMPOTENT. Every entry carries a stable `localId`; the server upserts on
//      it. A retry after a timeout cannot create a second waypoint, and a
//      timeout is the normal case on a weak link, not the exception.
//   3. ORDERED, but not blocking. Entries drain oldest-first because an
//      observation belongs to an expedition that must exist first — but one
//      entry the server keeps rejecting must not dam everything behind it, so a
//      failure is recorded with a backoff and the queue moves on.
//   4. BOUNDED, without losing work. At capacity the oldest SENT entries are
//      dropped. Unsent entries are never dropped; if the queue is full of
//      unsent work, that is a signal to surface, not data to throw away.
//
// This module knows nothing about geology, HTTP, or what the entries mean.
import { markPhase } from "../diagnostics/jsStall";

/** What kind of field record an entry carries. */
export type OutboxKind =
  | "expedition.open"
  | "expedition.close"
  | "observation"
  | "track"
  /**
   * A finished section's evidence package.
   *
   * Queued whole rather than as its parts: the assessment is of the MISSION, and
   * delivering observations one at a time would let the server analyse half a
   * day's work and call it a finding.
   */
  | "mission.package";

export interface OutboxEntry<T = unknown> {
  /** Stable across retries — the server's idempotency key. */
  localId: string;
  kind: OutboxKind;
  /** The expedition this belongs to, so a drain can order by campaign. */
  sessionId: string;
  /** The record itself, exactly as the API expects it. */
  payload: T;
  queuedAt: number;
  /** Set once the server has accepted it. */
  sentAt: number | null;
  attempts: number;
  lastAttemptAt: number | null;
  lastError: string | null;
}

export interface KeyValueAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/** One entry's outcome from a drain pass — see Outbox.applyResults(). */
export type OutboxAckOutcome =
  | { localId: string; kind: OutboxKind; result: "sent" }
  | { localId: string; kind: OutboxKind; result: "failed"; error: string }
  | { localId: string; kind: OutboxKind; result: "rejected"; error: string };

interface Envelope {
  version: 1;
  entries: OutboxEntry[];
}

export const OUTBOX_STORAGE_KEY = "sync.outbox.v1";

/** Entries held before the oldest SENT ones are dropped. */
export const OUTBOX_MAX_ENTRIES = 2_000;

/**
 * How long a failed entry waits before it is offered again.
 *
 * Doubling, capped at ten minutes. A field session lasts hours; retrying a
 * rejected entry every second for all of them would cost battery and change
 * nothing.
 */
export const RETRY_BASE_MS = 15_000;
export const RETRY_MAX_MS = 600_000;

export function retryDelayMs(attempts: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

/** Attempts after which an entry is called failing rather than merely retrying. */
export const FAILING_ATTEMPTS = 3;

/** Marks an error that will never succeed — see `markRejected`. */
const PERMANENT_PREFIX = "permanent: ";

/**
 * Where one record stands, as a single word.
 *
 * The queue always knew this; it could only say "pending" or "sent", and the
 * panel reported two numbers. A geologist reading "8 held · 4 failing" cannot
 * tell whether the 4 are waiting for a signal, being retried, or being refused
 * by the server for a reason the device already knows and is not showing.
 *
 *   queued    accepted by the device, never yet attempted
 *   retrying  attempted and failed, inside its backoff, will be offered again
 *   failing   still retrying, but it has now failed FAILING_ATTEMPTS times
 *   rejected  the server called it permanent; retired WITH its reason
 *   synced    the server has it
 *
 * Every one of these is stored on the device. That is not a state — it is the
 * invariant, and nothing leaves this queue unsent.
 */
export type OutboxState = "queued" | "retrying" | "failing" | "rejected" | "synced";

export function outboxStateOf(e: OutboxEntry): OutboxState {
  if (e.sentAt != null) {
    return e.lastError?.startsWith(PERMANENT_PREFIX) ? "rejected" : "synced";
  }
  if (e.attempts >= FAILING_ATTEMPTS) return "failing";
  return e.attempts > 0 ? "retrying" : "queued";
}

export interface OutboxStats {
  /** Unsent — what is still owed to the server. */
  pending: number;
  sent: number;
  /** Unsent entries that have failed FAILING_ATTEMPTS times or more. */
  failing: number;
  queued: number;
  retrying: number;
  rejected: number;
  synced: number;
  /** Every record the device is holding, whatever its state. Nothing is dropped. */
  stored: number;
  /** When the earliest backoff expires, so the panel can say "retry in 4 m". */
  nextRetryAt: number | null;
  /**
   * Distinct failure reasons, commonest first, with a count each.
   *
   * Grouped rather than listed: forty entries blocked by one 403 is one problem,
   * and printing it forty times buries it.
   */
  reasons: Array<{ reason: string; count: number; permanent: boolean }>;
}

function createAsyncStorageAdapter(): KeyValueAdapter {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const AsyncStorage = require("@react-native-async-storage/async-storage").default;
  return {
    getItem: (k) => AsyncStorage.getItem(k),
    setItem: (k, v) => AsyncStorage.setItem(k, v),
  };
}

type Listener = () => void;

export class Outbox {
  private entries: OutboxEntry[] = [];
  private storage: KeyValueAdapter;
  private now: () => number;
  private loaded = false;
  /** The single in-flight read, shared by every caller. */
  private loading: Promise<void> | null = null;
  private listeners = new Set<Listener>();
  // Writes are serialised: two enqueues in the same tick must not race each
  // other's read-modify-write and lose one of the two records.
  private writing: Promise<void> = Promise.resolve();

  constructor(deps: { storage?: KeyValueAdapter; now?: () => number } = {}) {
    this.storage = deps.storage ?? createAsyncStorageAdapter();
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
   * lost lease: `enqueue()` awaits `load()` and then persists, so a write landing
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
    // INSTRUMENTATION ONLY — see lib/diagnostics/jsStall.ts. Only persist()/
    // persist.stringify() were wrapped before; this read path never was, and a
    // mission.package entry embeds a full EvidencePackage as its payload, so this
    // can be reading substantially more than PackageStore's own blob. Loaded via
    // `void outbox.load()` in provider.tsx, same unattributed cold-start window
    // as packageStore.load(). Logging only; the read/parse/catch logic below is
    // unchanged.
    const done = markPhase("outbox.readOnce");
    try {
      const getStart = Date.now();
      const raw = await this.storage.getItem(OUTBOX_STORAGE_KEY);
      const getMs = Date.now() - getStart;
      if (!raw) {
        console.log(`[loadPhase] outbox.readOnce getItem=${getMs}ms (no stored data)`);
        return;
      }
      const parseStart = Date.now();
      const env = JSON.parse(raw) as Envelope;
      const parseMs = Date.now() - parseStart;
      if (env?.version === 1 && Array.isArray(env.entries)) {
        this.entries = env.entries.filter(isEntry);
      }
      // `raw.length` is UTF-16 code units, a fast proxy for bytes — not exact for
      // non-ASCII text, but this is a diagnostic order-of-magnitude check.
      console.log(
        `[loadPhase] outbox.readOnce getItem=${getMs}ms parse=${parseMs}ms ` +
        `records=${this.entries.length} bytes=${raw.length}`,
      );
    } catch {
      // Unreadable queue. Starting empty loses the queue, which is bad; throwing
      // loses the SESSION, which is worse. The field session continues.
    } finally {
      this.loaded = true;
      this.emit();
      done();
    }
  }

  /**
   * Append a record.
   *
   * `localId` is supplied by the caller rather than generated here, because the
   * caller is the one that can make it deterministic — a waypoint's own id, a
   * session id plus a segment number. That is what makes a retry after an
   * unknown outcome safe.
   */
  async enqueue<T>(kind: OutboxKind, sessionId: string, localId: string, payload: T): Promise<void> {
    await this.load();
    // Re-queuing the same record replaces it rather than duplicating: an edited
    // waypoint should reach the server as one row, in its final state.
    const existing = this.entries.findIndex((e) => e.localId === localId && e.kind === kind);
    const entry: OutboxEntry<T> = {
      localId, kind, sessionId, payload,
      queuedAt: this.now(),
      sentAt: null, attempts: 0, lastAttemptAt: null, lastError: null,
    };
    if (existing >= 0) this.entries[existing] = entry as OutboxEntry;
    else this.entries.push(entry as OutboxEntry);
    this.prune();
    await this.persist();
  }

  /** Everything still waiting, oldest first, whose backoff has expired. */
  due(at = this.now()): OutboxEntry[] {
    return this.entries
      .filter((e) => e.sentAt == null)
      .filter((e) => e.lastAttemptAt == null || at - e.lastAttemptAt >= retryDelayMs(e.attempts))
      .sort((a, b) => a.queuedAt - b.queuedAt);
  }

  pending(): OutboxEntry[] {
    return this.entries.filter((e) => e.sentAt == null);
  }

  all(): readonly OutboxEntry[] {
    return this.entries;
  }

  async markSent(localId: string, kind: OutboxKind): Promise<void> {
    this.applyOutcome({ localId, kind, result: "sent" });
    await this.persist();
  }

  async markFailed(localId: string, kind: OutboxKind, error: string): Promise<void> {
    this.applyOutcome({ localId, kind, result: "failed", error });
    await this.persist();
  }

  /**
   * The server will never accept this entry.
   *
   * Retired from the queue — it would fail identically for ever, and a slot held
   * open for it on a phone in the field costs the records behind it — but the
   * REASON is kept. Doing this as markFailed followed by markSent looks
   * equivalent and is not: a successful retry is supposed to clear a stale
   * error, so markSent clears it, and the one case where the error is the whole
   * point would silently lose it.
   */
  async markRejected(localId: string, kind: OutboxKind, error: string): Promise<void> {
    this.applyOutcome({ localId, kind, result: "rejected", error });
    await this.persist();
  }

  /**
   * The mutation markSent/markFailed/markRejected each make, WITHOUT
   * persisting — so a caller acknowledging many entries in one pass (see
   * applyResults) can apply them all in memory and pay for exactly one
   * serialise-and-write, not one per entry.
   */
  private applyOutcome(o: OutboxAckOutcome): void {
    const e = this.find(o.localId, o.kind);
    if (!e) return;
    if (o.result === "sent") {
      e.sentAt = this.now();
      e.lastError = null;
    } else if (o.result === "failed") {
      e.attempts += 1;
      e.lastAttemptAt = this.now();
      e.lastError = o.error.slice(0, 300);
    } else {
      e.attempts += 1;
      e.lastAttemptAt = this.now();
      e.sentAt = this.now();
      e.lastError = (PERMANENT_PREFIX + o.error).slice(0, 300);
    }
  }

  /**
   * Apply every acknowledgement from ONE DRAIN PASS, then persist once.
   *
   * THE BUG THIS FIXES. pushOutbox() used to call markSent/markFailed/
   * markRejected once per entry in the batch it just heard back on — up to
   * BATCH_SIZE (200) times per drain — and each of those persisted
   * immediately: a full JSON.stringify and AsyncStorage.setItem of the WHOLE
   * outbox, not just the entries that changed. Measured on an SM-A165F with an
   * 87-entry outbox: `outbox.persist` took ~52 SECONDS per call, and a drain
   * acknowledging 12 entries called it 12 times — the app-wide freeze this was
   * chasing, misattributed at first to targeting.rank() and then to the drain
   * itself, because nothing inside persist() had ever been measured on its own.
   *
   * Safe to batch: every entry carries a stable localId and the server upserts
   * on it (see the module header), so acknowledging N entries with one persist
   * instead of N changes nothing about correctness — only how many times the
   * SAME final state gets written to disk. If the app is killed before this
   * resolves, no entry's outcome was written, so every one of them is still
   * "due" next launch and gets retried — which the idempotent upsert already
   * makes safe, and is exactly what already happens for a drain that never
   * got a server response at all (a dropped connection mid-request).
   */
  async applyResults(outcomes: readonly OutboxAckOutcome[]): Promise<void> {
    if (outcomes.length === 0) return;
    for (const o of outcomes) this.applyOutcome(o);
    await this.persist();
  }

  /**
   * Every record in one state, so the panel can show the queue rather than
   * summarise it. Unsent entries first, worst first — the ones that need looking
   * at are the ones a geologist should not have to scroll for.
   */
  byState(): Array<{ entry: OutboxEntry; state: OutboxState }> {
    const rank: Record<OutboxState, number> = {
      failing: 0, rejected: 1, retrying: 2, queued: 3, synced: 4,
    };
    return this.entries
      .map((entry) => ({ entry, state: outboxStateOf(entry) }))
      .sort((a, b) => rank[a.state] - rank[b.state] || a.entry.queuedAt - b.entry.queuedAt);
  }

  /** Counts for the status line: what is still owed to the server, and why. */
  stats(at = this.now()): OutboxStats {
    let pending = 0, sent = 0, failing = 0;
    let queued = 0, retrying = 0, rejected = 0, synced = 0;
    let nextRetryAt: number | null = null;
    const reasons = new Map<string, { count: number; permanent: boolean }>();

    for (const e of this.entries) {
      const state = outboxStateOf(e);
      if (state === "synced") synced++;
      if (state === "rejected") rejected++;
      if (state === "queued") queued++;
      if (state === "retrying") retrying++;
      if (state === "failing") failing++;

      if (e.sentAt != null) sent++;
      else {
        pending++;
        // When this entry becomes due again. `at` is unused for entries never
        // attempted — those are due now, which is why they report no wait.
        if (e.lastAttemptAt != null) {
          const due = e.lastAttemptAt + retryDelayMs(e.attempts);
          if (due > at && (nextRetryAt == null || due < nextRetryAt)) nextRetryAt = due;
        }
      }

      // Reasons are collected for anything that HAS one and is not simply done —
      // a retired-permanent entry keeps its reason precisely so it stays visible.
      if (e.lastError && state !== "synced") {
        const permanent = e.lastError.startsWith(PERMANENT_PREFIX);
        const key = permanent ? e.lastError.slice(PERMANENT_PREFIX.length) : e.lastError;
        const seen = reasons.get(key);
        if (seen) seen.count++;
        else reasons.set(key, { count: 1, permanent });
      }
    }

    return {
      pending, sent, failing, queued, retrying, rejected, synced,
      stored: this.entries.length,
      nextRetryAt,
      reasons: [...reasons.entries()]
        .map(([reason, v]) => ({ reason, count: v.count, permanent: v.permanent }))
        .sort((a, b) => b.count - a.count),
    };
  }

  private find(localId: string, kind: OutboxKind): OutboxEntry | undefined {
    return this.entries.find((e) => e.localId === localId && e.kind === kind);
  }

  /**
   * Keep the queue bounded — by forgetting what the server already has.
   *
   * Unsent entries are never dropped. If the cap is reached with nothing sent,
   * the queue grows past it: losing a geologist's observations to make room for
   * newer ones is not a trade this app is allowed to make.
   */
  private prune(): void {
    if (this.entries.length <= OUTBOX_MAX_ENTRIES) return;
    const overBy = this.entries.length - OUTBOX_MAX_ENTRIES;
    const sentOldestFirst = this.entries
      .filter((e) => e.sentAt != null)
      .sort((a, b) => (a.sentAt ?? 0) - (b.sentAt ?? 0))
      .slice(0, overBy);
    if (sentOldestFirst.length === 0) return;
    const drop = new Set(sentOldestFirst);
    this.entries = this.entries.filter((e) => !drop.has(e));
  }

  private async persist(): Promise<void> {
    // INVESTIGATION: pushOutbox's per-entry ack loop calls markSent/markFailed/
    // markRejected once per due entry, and each of those calls persist() — a
    // full JSON.stringify + AsyncStorage.setItem of EVERY entry this device is
    // holding, not just the ones being updated. Named with the current size so
    // a slow persist is attributed by exactly how much it was serialising.
    const donePersist = markPhase(`outbox.persist[${this.entries.length}]`);
    const env: Envelope = { version: 1, entries: this.entries };
    const write = this.writing.then(async () => {
      try {
        const doneStringify = markPhase(`outbox.persist.stringify[${this.entries.length}]`);
        const json = JSON.stringify(env);
        doneStringify();
        await this.storage.setItem(OUTBOX_STORAGE_KEY, json);
      } catch {
        // Out of storage, or the platform refused. The entries are still in
        // memory and the next write may succeed; the session is not interrupted.
      }
    });
    this.writing = write;
    await write;
    this.emit();
    donePersist();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

function isEntry(v: unknown): v is OutboxEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Partial<OutboxEntry>;
  return typeof e.localId === "string" && typeof e.kind === "string" && typeof e.queuedAt === "number";
}

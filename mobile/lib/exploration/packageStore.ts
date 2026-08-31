// Evidence packages on the device, and their journey to the server.
//
// OFFLINE FIRST, and not as a fallback. The field has no network — that is the
// normal case, not the exception — so FINISH SECTION writes to disk and returns.
// Everything after that is the sync layer's problem, and the geologist has
// already been told their work is safe.
//
// WHAT IS KEPT, AND WHAT IS NOT
//
// A package is the record of a day's work and a geologist who cannot reread what
// they submitted has to trust the app instead of checking it. So packages are kept
// — but not for ever, and this file said "never deleted" until the arithmetic was
// done: the whole store is parsed into memory on every launch, a package with
// twenty observations is 15-25 KB, and a season of field work is hundreds of
// missions. That is the same unbounded-JSON mistake that once took this app from
// 297 MB to 588 MB at startup.
//
// So: the most recent KEEP_PACKAGES are held in full. Beyond that, the oldest
// DELIVERED ones are dropped, and only those — a package still waiting to upload
// or waiting for its assessment is the geologist's unfinished work and is never
// discarded to save space. The evidence itself is in R2 and Postgres either way.
import { Outbox, type KeyValueAdapter } from "../sync/outbox";
import {
  isDeliverable, type EvidencePackage, type PackageAnalysis,
} from "./evidencePackage";
import { markPhase } from "../diagnostics/jsStall";
import type { MissionOutcome } from "./mission";

export const PACKAGE_STORAGE_KEY = "exploration.packages.v1";
/** The outbox kind. The server dispatches on this string. */
export const PACKAGE_OUTBOX_KIND = "mission.package";
/**
 * How many finished sections to keep on the device, in full.
 *
 * Sixty is a long field season at one mission a day. Older ones live on the
 * server, which is where a report is read from anyway.
 */
export const KEEP_PACKAGES = 60;

/** Where a package has got to. Derived, never stored — one authority. */
export type PackageDelivery = "local" | "queued" | "sent" | "analysed";

export function deliveryOf(p: EvidencePackage, queued: boolean, sent: boolean): PackageDelivery {
  if (p.analysis) return "analysed";
  if (sent) return "sent";
  return queued ? "queued" : "local";
}

function createAsyncStorageAdapter(): KeyValueAdapter {
  // Required lazily so this module can be tested with no React Native runtime.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const AsyncStorage = require("@react-native-async-storage/async-storage").default;
  return {
    getItem: (k: string) => AsyncStorage.getItem(k),
    setItem: (k: string, v: string) => AsyncStorage.setItem(k, v),
  };
}

type Listener = () => void;

export class PackageStore {
  private packages: EvidencePackage[] = [];
  private loaded = false;
  private readonly storage: KeyValueAdapter;
  private readonly now: () => number;
  private readonly listeners = new Set<Listener>();
  /** Writes are serialised, so two saves in one tick cannot lose one another. */
  private queue: Promise<void> = Promise.resolve();

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
    // INSTRUMENTATION ONLY — see lib/diagnostics/jsStall.ts. Loaded via `void
    // packages.load()` in provider.tsx during the first render, which resolves
    // outside app.providers.graph's markPhase window — so a slow parse here has
    // been invisible until now. Logging only; the read/parse/catch logic below
    // is unchanged.
    const done = markPhase("packageStore.load");
    try {
      const getStart = Date.now();
      const raw = await this.storage.getItem(PACKAGE_STORAGE_KEY);
      const getMs = Date.now() - getStart;
      const parseStart = Date.now();
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      const parseMs = Date.now() - parseStart;
      // A corrupt store must not take the app down with it, and must not silently
      // masquerade as "no packages" either — see `readError`.
      this.packages = Array.isArray(parsed) ? (parsed as EvidencePackage[]).filter(isDeliverable) : [];
      // `raw.length` is UTF-16 code units, a fast proxy for bytes — not exact for
      // non-ASCII text, but this is a diagnostic order-of-magnitude check.
      console.log(
        `[loadPhase] packageStore.load getItem=${getMs}ms parse=${parseMs}ms ` +
        `records=${this.packages.length} bytes=${raw?.length ?? 0}`,
      );
    } catch (e) {
      this.packages = [];
      this.readError = e instanceof Error ? e.message : String(e);
    } finally {
      this.loaded = true;
      this.notify();
      done();
    }
  }

  /**
   * Why the store came up empty, when it was not simply empty.
   *
   * Surfaced in diagnostics rather than swallowed: "no packages" and "the file
   * would not parse" are different situations, and only one of them means the
   * geologist's work is gone.
   */
  readError: string | null = null;

  all(): readonly EvidencePackage[] {
    return this.packages;
  }

  get(id: string): EvidencePackage | null {
    return this.packages.find((p) => p.id === id) ?? null;
  }

  /** Packages with no assessment back yet — what the sync layer is working on. */
  awaitingAnalysis(): readonly EvidencePackage[] {
    return this.packages.filter((p) => p.analysis == null);
  }

  /**
   * Save a finished package, then queue it.
   *
   * The order is load-bearing. Disk first: if the process dies between the two,
   * the work still exists and can be re-queued, whereas a queue entry with no
   * package behind it is a promise the device cannot keep.
   */
  async save(p: EvidencePackage, outbox?: Outbox): Promise<void> {
    await this.load();
    await this.write(() => {
      const i = this.packages.findIndex((x) => x.id === p.id);
      if (i >= 0) this.packages[i] = p;
      else this.packages.push(p);
    });
    if (outbox) await this.enqueue(p, outbox);
  }

  /**
   * Hand the package to the durable queue.
   *
   * `localId` is the package id, which makes the upload idempotent: a retry after
   * a timeout that actually succeeded cannot create a second mission on the
   * server.
   */
  async enqueue(p: EvidencePackage, outbox: Outbox): Promise<void> {
    await outbox.enqueue(
      PACKAGE_OUTBOX_KIND as never,
      p.explorationSessionId ?? p.missionId,
      p.id,
      p,
    );
  }

  /** Record the assessment when it comes back. Clears any earlier failure. */
  async attachAnalysis(id: string, analysis: PackageAnalysis): Promise<void> {
    await this.load();
    await this.write(() => {
      const i = this.packages.findIndex((x) => x.id === id);
      if (i >= 0) this.packages[i] = { ...this.packages[i], analysis, analysisError: null };
    });
  }

  /**
   * Record WHY an assessment did not come back.
   *
   * Separate from "not yet". A package waiting on its photographs and a package
   * whose analysis failed are indistinguishable without this, and only one of
   * them needs a person to do something. The evidence is untouched either way —
   * this writes one string beside it and nothing else.
   */
  async attachError(id: string, reason: string): Promise<void> {
    await this.load();
    await this.write(() => {
      const i = this.packages.findIndex((x) => x.id === id);
      if (i >= 0) this.packages[i] = { ...this.packages[i], analysisError: reason };
    });
  }

  /**
   * Record what the server last said, without calling it a failure.
   *
   * Separate from `attachError` because the state must not change: a package
   * waiting on its photographs is waiting, not failed, and flipping it to failed
   * would send a geologist looking for a problem that will clear itself. What was
   * missing was never the state — it was the sentence underneath it.
   *
   * Written only when the note actually changes, so a sixty-second retry loop does
   * not rewrite the whole store every pass.
   */
  async noteAttempt(id: string, note: string | null): Promise<void> {
    await this.load();
    const i = this.packages.findIndex((x) => x.id === id);
    if (i < 0 || (this.packages[i].analysisNote ?? null) === note) return;
    await this.write(() => {
      this.packages[i] = { ...this.packages[i], analysisNote: note };
    });
  }

  /**
   * Record whether the target turned out to be worth the walk (Priority 6,
   * instrumentation only).
   *
   * Callable at ANY time, on ANY package still on the device — never gated to
   * the package's delivery state. That is the whole point: an assay comes
   * back weeks after the walk, and the mission that produced the sample may
   * already be long delivered and closed by then.
   */
  async setOutcome(id: string, outcome: MissionOutcome): Promise<void> {
    await this.load();
    const i = this.packages.findIndex((x) => x.id === id);
    if (i < 0) return;
    await this.write(() => {
      this.packages[i] = { ...this.packages[i], outcome };
    });
  }

  /**
   * Drop the oldest DELIVERED packages once the store is over its bound.
   *
   * A package is delivered when its assessment has come back. Anything without
   * one is either still uploading or still waiting to be read, and dropping that
   * would throw away work the geologist has not yet seen the result of — so the
   * bound is allowed to be exceeded rather than break that.
   */
  private prune(): void {
    if (this.packages.length <= KEEP_PACKAGES) return;
    const delivered = this.packages
      .filter((p) => p.analysis != null)
      .sort((a, b) => a.createdAt - b.createdAt);
    const overBy = this.packages.length - KEEP_PACKAGES;
    const drop = new Set(delivered.slice(0, overBy).map((p) => p.id));
    if (drop.size === 0) return;
    this.packages = this.packages.filter((p) => !drop.has(p.id));
  }

  private async write(mutate: () => void): Promise<void> {
    this.queue = this.queue.then(async () => {
      mutate();
      this.prune();
      await this.storage.setItem(PACKAGE_STORAGE_KEY, JSON.stringify(this.packages));
      this.notify();
    });
    return this.queue;
  }
}

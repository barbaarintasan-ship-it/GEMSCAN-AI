// User Geological Evidence, held on the device — one record per mission.
//
// Same reason the waypoint and package stores exist: the field has no network,
// and a geologist who fills in an assay result then loses signal (or the app)
// must not lose it. Written to disk on every save, read back on the next
// launch, keyed by mission id so a record can never attach itself to the wrong
// mission's package.
//
// CLEARED once its mission's package is filed (`clear()`, called by the
// provider right after `finishSection()` succeeds) — the record has already
// been folded into the package by then, and a copy living here forever would
// be the same unbounded-growth mistake `packageStore.ts` was built to avoid.
import type { KeyValueAdapter } from "../sync/outbox";
import {
  emptyStructuredEvidence,
  type StructuredEvidenceResult, type StructuredGeologicalEvidence,
} from "../field/structuredEvidenceTypes";

export const STRUCTURED_EVIDENCE_STORAGE_KEY = "exploration.structuredEvidence.v1";

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

export class StructuredEvidenceStore {
  private records: Record<string, StructuredGeologicalEvidence> = {};
  private loaded = false;
  private readonly storage: KeyValueAdapter;
  private readonly listeners = new Set<Listener>();
  private queue: Promise<void> = Promise.resolve();

  constructor(deps: { storage?: KeyValueAdapter } = {}) {
    this.storage = deps.storage ?? createAsyncStorageAdapter();
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
      const raw = await this.storage.getItem(STRUCTURED_EVIDENCE_STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      this.records = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, StructuredGeologicalEvidence>)
        : {};
    } catch {
      // A corrupt store reads as empty rather than taking the app down with it.
      this.records = {};
    } finally {
      this.loaded = true;
      this.notify();
    }
  }

  /** The record for one mission, or null when nothing has been entered yet. */
  get(missionId: string): StructuredGeologicalEvidence | null {
    return this.records[missionId] ?? null;
  }

  /**
   * Append one form save's sections onto the mission's record, creating it on
   * first use. APPEND, never overwrite — a second assay result joins the first
   * rather than replacing it, the same "capture, don't overwrite" rule
   * waypoints already follow.
   */
  async merge(
    missionId: string, siteId: string, commodity: string | null,
    result: StructuredEvidenceResult, now: number,
  ): Promise<StructuredGeologicalEvidence> {
    await this.load();
    let updated!: StructuredGeologicalEvidence;
    await this.write(() => {
      const existing = this.records[missionId] ?? emptyStructuredEvidence(missionId, siteId, commodity, now);
      updated = {
        ...existing,
        updatedAt: now,
        assays: result.assay ? [...existing.assays, result.assay] : existing.assays,
        geophysics: result.geophysics ? [...existing.geophysics, result.geophysics] : existing.geophysics,
        mapping: result.mapping ? [...existing.mapping, result.mapping] : existing.mapping,
        remoteSensing: result.remoteSensing ? [...existing.remoteSensing, result.remoteSensing] : existing.remoteSensing,
        fieldObservations: result.fieldObservation
          ? [...existing.fieldObservations, result.fieldObservation]
          : existing.fieldObservations,
      };
      this.records[missionId] = updated;
    });
    return updated;
  }

  /** The record has been folded into a finished package; stop holding a copy. */
  async clear(missionId: string): Promise<void> {
    await this.load();
    if (!(missionId in this.records)) return;
    await this.write(() => {
      delete this.records[missionId];
    });
  }

  private async write(mutate: () => void): Promise<void> {
    this.queue = this.queue.then(async () => {
      mutate();
      await this.storage.setItem(STRUCTURED_EVIDENCE_STORAGE_KEY, JSON.stringify(this.records));
      this.notify();
    });
    return this.queue;
  }
}

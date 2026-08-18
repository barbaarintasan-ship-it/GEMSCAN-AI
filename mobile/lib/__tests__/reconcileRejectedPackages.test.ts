// Recovering the schema-routing incident's stuck mission.package entries.
//
// The rule under test is narrow on purpose: only an entry the outbox still
// calls "rejected", for exactly this incident's PostgREST signature, is ever
// touched. A synced mission, a rejection for a real reason, or a package with
// no outbox trace at all must come out of this pass completely unchanged —
// that is what stops a recovery pass from ever duplicating a delivered
// mission or resurrecting a genuinely broken one.
import { reconcileRejectedPackages, isKnownDeploymentRejection } from "../sync/reconcileRejectedPackages";
import { PackageStore, PACKAGE_STORAGE_KEY, PACKAGE_OUTBOX_KIND } from "../exploration/packageStore";
import { Outbox, OUTBOX_STORAGE_KEY, type KeyValueAdapter, type OutboxEntry } from "../sync/outbox";
import { EVIDENCE_PACKAGE_VERSION, type EvidencePackage } from "../exploration/evidencePackage";

function memoryStorage(seed?: unknown): KeyValueAdapter & { data: Map<string, string> } {
  const data = new Map<string, string>();
  if (seed) data.set(PACKAGE_STORAGE_KEY, JSON.stringify(seed));
  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => { data.set(k, v); },
  };
}

function pkg(id: string, over: Partial<EvidencePackage> = {}): EvidencePackage {
  return {
    version: EVIDENCE_PACKAGE_VERSION, id, missionId: id, explorationSessionId: "ex-1",
    createdAt: 1_760_000_000_000,
    targetCell: "87abc", targetCentre: { lat: 9.5, lng: 43.1 },
    hotspot: null, commodity: "gold", prospectivityScore: 0.4, targetReasons: [],
    geologyContext: null, terrainContext: null, structuralContext: [], coverage: null,
    engineReadings: null,
    observations: [], track: [], arrivedAt: null, completedAt: 1_760_000_000_000,
    analysis: null,
    ...over,
  } as EvidencePackage;
}

function store(seed: EvidencePackage[]) {
  return new PackageStore({ storage: memoryStorage(seed), now: () => 1_760_000_000_000 });
}

function outboxEntry(over: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    localId: "ms-1", kind: PACKAGE_OUTBOX_KIND, sessionId: "ex-1", payload: { id: "ms-1" },
    queuedAt: 1_760_000_000_000, sentAt: null, attempts: 0, lastAttemptAt: null, lastError: null,
    ...over,
  } as OutboxEntry;
}

function seededOutbox(entries: OutboxEntry[]): Outbox {
  const data = new Map<string, string>();
  data.set(OUTBOX_STORAGE_KEY, JSON.stringify({ version: 1, entries }));
  const adapter: KeyValueAdapter = {
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => { data.set(k, v); },
  };
  return new Outbox({ storage: adapter });
}

const SCHEMA_ERROR =
  "Could not find the function geo.upsert_mission_package(p_actor, p_package) in the schema cache";

describe("isKnownDeploymentRejection", () => {
  test("matches the incident's PostgREST signature, with or without the permanent: prefix", () => {
    expect(isKnownDeploymentRejection(`permanent: ${SCHEMA_ERROR}`)).toBe(true);
    expect(isKnownDeploymentRejection(SCHEMA_ERROR)).toBe(true);
    expect(isKnownDeploymentRejection("permanent: PostgREST schema cache is stale")).toBe(true);
  });

  test("does not match a real data-fault rejection", () => {
    expect(isKnownDeploymentRejection("permanent: package ms-1 has no targetCell")).toBe(false);
    expect(isKnownDeploymentRejection("permanent: a track needs at least two points")).toBe(false);
  });

  test("null is never a match", () => {
    expect(isKnownDeploymentRejection(null)).toBe(false);
  });
});

describe("reconcileRejectedPackages", () => {
  test("requeues a package whose entry was rejected for the known reason", async () => {
    const s = store([pkg("ms-1")]);
    const box = seededOutbox([
      outboxEntry({ localId: "ms-1", sentAt: 2_000, attempts: 1, lastError: `permanent: ${SCHEMA_ERROR}` }),
    ]);

    const r = await reconcileRejectedPackages(s, box);

    expect(r.requeuedMissionIds).toEqual(["ms-1"]);
    const entry = box.all().find((e) => e.localId === "ms-1")!;
    expect(entry.sentAt).toBeNull();
    expect(box.due().map((e) => e.localId)).toEqual(["ms-1"]);
  });

  test("a synced mission is left completely untouched", async () => {
    const s = store([pkg("ms-1")]);
    const seeded = outboxEntry({ localId: "ms-1", sentAt: 2_000, attempts: 1, lastError: null });
    const box = seededOutbox([seeded]);

    const r = await reconcileRejectedPackages(s, box);

    expect(r.requeuedMissionIds).toEqual([]);
    expect(box.all()[0]).toEqual(seeded);
  });

  test("a rejection for a real, unrelated reason is left alone", async () => {
    const s = store([pkg("ms-1")]);
    const box = seededOutbox([
      outboxEntry({
        localId: "ms-1", sentAt: 2_000, attempts: 1,
        lastError: "permanent: package ms-1 has no targetCell",
      }),
    ]);

    const r = await reconcileRejectedPackages(s, box);

    expect(r.requeuedMissionIds).toEqual([]);
    expect(box.all()[0].sentAt).toBe(2_000);
  });

  test("a package with no outbox entry at all is requeued too", async () => {
    // MEASURED on a field phone: Outbox.prune() drops the oldest SENT entries
    // past OUTBOX_MAX_ENTRIES, and a rejected entry counts as sent — so months
    // of field use can erase the rejection's own record while PackageStore
    // (which never prunes an unanalysed package) still holds the evidence.
    // Nothing recorded says this is a genuine fault, so it is in scope.
    const s = store([pkg("ms-1")]);
    const box = seededOutbox([]);

    const r = await reconcileRejectedPackages(s, box);

    expect(r.requeuedMissionIds).toEqual(["ms-1"]);
    expect(box.due().map((e) => e.localId)).toEqual(["ms-1"]);
  });

  test("running it twice when there was never an outbox entry requeues once", async () => {
    const s = store([pkg("ms-1")]);
    const box = seededOutbox([]);

    const first = await reconcileRejectedPackages(s, box);
    const second = await reconcileRejectedPackages(s, box);

    expect(first.requeuedMissionIds).toEqual(["ms-1"]);
    // The requeue created a real (queued) entry, so the second pass sees a
    // live entry and leaves it alone rather than requeuing again.
    expect(second.requeuedMissionIds).toEqual([]);
    expect(box.all()).toHaveLength(1);
  });

  test("a package that already has its analysis is never inspected", async () => {
    const analysed = pkg("ms-1", { analysis: {} as never });
    const s = store([analysed]);
    const box = seededOutbox([
      outboxEntry({ localId: "ms-1", sentAt: 2_000, attempts: 1, lastError: `permanent: ${SCHEMA_ERROR}` }),
    ]);

    const r = await reconcileRejectedPackages(s, box);

    expect(r.requeuedMissionIds).toEqual([]);
  });

  test("running it twice with no drain in between requeues once", async () => {
    const s = store([pkg("ms-1")]);
    const box = seededOutbox([
      outboxEntry({ localId: "ms-1", sentAt: 2_000, attempts: 1, lastError: `permanent: ${SCHEMA_ERROR}` }),
    ]);

    const first = await reconcileRejectedPackages(s, box);
    const second = await reconcileRejectedPackages(s, box);

    expect(first.requeuedMissionIds).toEqual(["ms-1"]);
    // Requeued entry is now "queued" (sentAt: null, no lastError) — no longer
    // "rejected", so the second pass has nothing to do and creates nothing new.
    expect(second.requeuedMissionIds).toEqual([]);
    expect(box.all().filter((e) => e.localId === "ms-1")).toHaveLength(1);
  });

  test("a mixed batch requeues exactly the one eligible mission", async () => {
    const s = store([
      pkg("ms-1"), pkg("ms-2"), pkg("ms-3"),
      pkg("ms-4", { analysis: {} as never }),
    ]);
    const box = seededOutbox([
      outboxEntry({ localId: "ms-1", sentAt: 2_000, attempts: 1, lastError: `permanent: ${SCHEMA_ERROR}` }), // eligible
      outboxEntry({ localId: "ms-2", sentAt: 2_000, attempts: 1, lastError: null }), // synced
      outboxEntry({
        localId: "ms-3", sentAt: 2_000, attempts: 1,
        lastError: "permanent: package ms-3 has no targetCell", // real fault
      }),
      // ms-4 has no outbox entry at all, and is already analysed besides.
    ]);

    const r = await reconcileRejectedPackages(s, box);

    expect(r.requeuedMissionIds).toEqual(["ms-1"]);
  });
});

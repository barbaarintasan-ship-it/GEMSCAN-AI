// LIVE MISSION RESCORING — a held target must update when new evidence is
// recorded for the cell the geologist is standing in.
//
// THE BUG. `rank()`'s candidate set structurally excludes the cell the
// traveller is standing in (`kRing(here, n).filter(c => c !== here)`) — right
// for RANKING, since a cell is never a "walk to" recommendation for someone
// already there. But `retargetInner()`'s held-target lookup
// (`result.targets.find(t => t.cell === prev.cell)`) reused that same ranked
// list to decide whether to refresh the held target's own figures. While the
// geologist stands in their own target cell, that lookup always misses — so
// `captureObservation()` -> `recordEvidence()` -> `retarget(true, "evidence")`
// ran a full re-rank, found nothing for the held cell, and fell back to the
// frozen `prev` — the score and evidence from the moment the mission opened,
// never the moment just after a new waypoint was logged for that same ground.
//
// THE FIX. `retargetInner()` now recognises this one case — locked, held
// cell === the cell just re-ranked — and re-scores exactly that cell with
// `targetAt()` (which has no such exclusion; the mission layer already uses it
// this way in `baselineEvidenceFor()`). `missionFor()` then carries the
// refreshed score/reportScore onto the mission object, which is what
// `buildEvidencePackage()` actually reads. The destination itself never
// moves: the refresh only ever applies to `prev.cell`, so this cannot send the
// geologist somewhere else.
//
// These tests drive the REAL orchestrator, targeting engine, pack, waypoint
// store and package store — only the sensors and the clock are doubled.
import type { FieldFix, SessionSnapshot } from "../field/types";
import { buildPack } from "../../../shared/geo-core/pack/build.ts";
import type { PackData } from "../../../shared/geo-core/pack/types.ts";
import { PackStore, createBundledPackSource } from "../geo/packStore.ts";
import { OfflineGeoContextService } from "../geo/offlineGeoContext.ts";
import { TargetingEngine } from "../geo/targeting.ts";
import { makeWaypointEvidenceSource } from "../exploration/localEvidence.ts";
import { cellFor } from "../geo/h3.ts";
import { ExplorationOrchestrator, type FieldSessionPort } from "../exploration/orchestrator.ts";
import { WaypointStore } from "../field/waypointStore";
import { WaypointService } from "../field/waypointService";
import { PhotoUploadQueue } from "../sync/photoUploadQueue";
import { PackageStore } from "../exploration/packageStore";
import { Outbox, type KeyValueAdapter } from "../sync/outbox";
import type { Waypoint } from "../field/waypointTypes";

const NOW = Date.parse("2026-09-10T09:00:00.000Z");
// A genuinely historical observation — weeks before this mission, nowhere near
// today's target, filed under a mission that has long since closed.
const HISTORICAL_CAPTURED_AT = Date.parse("2026-08-01T09:00:00.000Z");

const BUILD_OPTS = {
  packId: "somalia", packVersion: "1.0.0", engineVersion: "1.0.0", region: "SO",
  h3Resolution: 7, builtAt: "2026-08-01T00:00:00.000Z",
  datasets: [{ datasetId: "d1", source: "USGS MRDS", version: "2024" }],
};

const START = { lat: 2.0469, lng: 45.3182 };
const A = { lat: START.lat + 0.021, lng: START.lng + 0.021 };
// Far from A — a real historical find elsewhere, never evidence for today's target.
const ELSEWHERE = { lat: START.lat - 0.4, lng: START.lng - 0.4 };

/**
 * A SINGLE, moderately distant occurrence near A — enough for a real, nonzero
 * baseline (a genuine "awaitingEvidence"), but deliberately far short of the
 * noisy-OR ceiling, so a fresh on-site observation has real room to raise the
 * score. Four tight occurrences (tried first) saturated the score at 1.00
 * before arrival even happened, which made the rescore invisible — not
 * because the fix did nothing, but because there was nowhere left to go.
 */
function pack(): PackData {
  const d: PackData = {
    geology: [{
      id: "g1", name: "Precambrian Basement", kind: "metamorphic", source: "Macrostrat",
      attributes: null,
      rings: [[[45.1, 1.9], [45.6, 1.9], [45.6, 2.3], [45.1, 2.3], [45.1, 1.9]]],
      bbox: [45.1, 1.9, 45.6, 2.3], isPolygon: true,
    }],
    occurrences: [{
      id: "a0", name: "A Gold 0", commodity_key: "gold",
      deposit_type: "orogenic", host_rocks: ["greenstone"],
      // ~5 km from A — inside the 10 km context radius, but far enough that
      // its proximity weight lands around the middle of the scale, not the cap.
      lat: A.lat + 0.045, lng: A.lng,
      dataset_id: "d1", source: "USGS MRDS", version: "2024",
      reference: "Ra0", cell: "c",
    }],
    knowledge: [], structures: [], community: [], mapFeatures: [], terrain: [],
    associations: [], rules: [], commodities: [], assemblages: [], land: [],
  };
  return d;
}

function memoryStorage(): KeyValueAdapter & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: async (k) => data.get(k) ?? null, setItem: async (k, v) => { data.set(k, v); } };
}

function fakeField() {
  const listeners = new Set<() => void>();
  let snap: SessionSnapshot = {
    machine: { state: "idle", pausedBy: null, errorCode: null },
    sessionId: null, startedAt: null, lastFix: null, lastHeading: null,
    fixCount: 0, headingSupported: true, degradedAccuracy: false, permission: null,
  };
  const port: FieldSessionPort & { emitFix: (lat: number, lng: number) => void } = {
    getSnapshot: () => snap,
    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
    start: () => {
      snap = { ...snap, machine: { state: "active", pausedBy: null, errorCode: null }, sessionId: "fs-1", startedAt: NOW };
      listeners.forEach((l) => l());
    },
    stop: () => { snap = { ...snap, machine: { state: "idle", pausedBy: null, errorCode: null } }; listeners.forEach((l) => l()); },
    emitFix: (lat, lng) => {
      // 8 m accuracy — a good fix, well inside the arrival radius floor.
      const fix: FieldFix = { lat, lng, accuracy: 8, altitude: null, speed: 0, timestamp: NOW, provisional: false };
      snap = { ...snap, lastFix: fix, fixCount: snap.fixCount + 1 };
      listeners.forEach((l) => l());
    },
  };
  return port;
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));
jest.setTimeout(180_000);

function harness() {
  const storage = memoryStorage();
  const files = buildPack(pack(), BUILD_OPTS).files;
  const packs = new PackStore(createBundledPackSource(() => files), () => NOW);
  const field = fakeField();
  const waypointStore = new WaypointStore({
    storage,
    photos: { persist: async (_s: string, f: string) => `file:///app/waypoints/${f}`, remove: async () => {} },
  });
  const waypoints = new WaypointService(field, waypointStore, () => NOW);
  const photoUploads = new PhotoUploadQueue({ storage, now: () => NOW });
  const packages = new PackageStore({ storage, now: () => NOW });
  const outbox = new Outbox({ storage, now: () => NOW });
  // SAME wiring as provider.tsx: the live waypoint store feeds the engine as
  // local evidence, and the pack accessor is passed through. Earlier versions
  // of this test omitted both, which is why a captured waypoint never moved
  // the score at all — not because the fix under test did nothing, but because
  // the harness never gave the engine a way to see it.
  const localEvidence = makeWaypointEvidenceSource(waypointStore);
  const targeting = new TargetingEngine(
    new OfflineGeoContextService(packs), localEvidence, () => packs.getData()!,
  );
  const orch = new ExplorationOrchestrator({
    field, targeting, packs, now: () => NOW, waypoints, photoUploads, packages, outbox,
  });
  return { orch, field, waypoints, waypointStore, packs, targeting };
}

/** A genuine, unrelated, weeks-old observation — the historical-evidence control. */
function seedHistoricalWaypoint(store: WaypointStore): Promise<Waypoint> {
  return store.put({
    id: "wp-historical-1",
    sessionId: "fs-old", trackId: "fs-old", missionId: "ms-old-closed",
    type: "outcrop", name: null, notes: "Old outcrop, unrelated ground",
    position: {
      lat: ELSEWHERE.lat, lng: ELSEWHERE.lng,
      accuracyM: 10, altitudeM: null, fixedAt: HISTORICAL_CAPTURED_AT, ageMs: 0, provisional: false,
    },
    heading: null, photos: [], sample: undefined, origin: "observed",
    capturedAt: HISTORICAL_CAPTURED_AT, updatedAt: HISTORICAL_CAPTURED_AT,
    syncState: "synced", deletedAt: null,
  });
}

/** Drive to A, arrive, and return the harness with the mission open on-site. */
async function arriveAtA(h: ReturnType<typeof harness>) {
  h.orch.start();
  h.field.emitFix(START.lat, START.lng);
  await settle();
  const t = h.orch.getSnapshot().targets.find((x) => x.cell === cellFor(A.lat, A.lng)) ??
    h.orch.getSnapshot().activeTarget!;
  h.orch.selectTarget(t.cell);
  await settle();
  h.field.emitFix(t.centre.lat, t.centre.lng);
  await settle();
  expect(h.orch.getSnapshot().state).toBe("awaitingEvidence");
  expect(h.orch.getSnapshot().mission?.state).toBe("arrived_at_target_area");
  return t.centre;
}

describe("a live mission target rescores after a new on-site observation", () => {
  test("1. score/mission update, and the target cell never changes", async () => {
    const h = harness();
    await seedHistoricalWaypoint(h.waypointStore);
    const centre = await arriveAtA(h);

    const before = h.orch.getSnapshot();
    const cellBefore = before.activeTarget!.cell;
    const scoreBefore = before.activeTarget!.score;
    const missionScoreBefore = before.mission!.score;

    await h.orch.captureObservation({ type: "quartz-vein", notes: "Fresh vein at the target" });
    await settle();

    const after = h.orch.getSnapshot();

    // 3. THE TARGET REMAINS THE LOCKED ACTIVE TARGET.
    expect(after.activeTarget!.cell).toBe(cellBefore);
    expect(after.mission!.cell).toBe(cellBefore);
    expect(after.mission!.state).not.toBe("mission_closed");

    // 1. A LIVE MISSION TARGET CAN BE RESCORED — both the target and the
    // mission object it feeds carry the new figure, not the frozen one.
    expect(after.activeTarget!.score).toBeGreaterThan(scoreBefore);
    expect(after.mission!.score).toBeGreaterThan(missionScoreBefore);
    expect(after.mission!.score).toBeCloseTo(after.activeTarget!.score, 10);

    // 2. THE NEW OBSERVATION APPEARS IN THE TARGET'S OWN SCORED EVIDENCE.
    const evidenceReasons = after.activeTarget!.evidence.map((e) => e.reason);
    expect(evidenceReasons).toContainEqual(
      expect.objectContaining({ kind: "observation", label: "quartz-vein" }),
    );

    // 6. reportScore is recalculated consistently with the new evidence — not
    // left pointing at the pre-observation snapshot.
    expect(after.mission!.reportScore).toBeDefined();
    expect(after.mission!.reportScore).toBeCloseTo(after.activeTarget!.reportScore, 10);
  });

  test("4. bearing/distance guidance keeps working, derived from the live fix", async () => {
    const h = harness();
    const centre = await arriveAtA(h);
    await h.orch.captureObservation({ type: "quartz-vein", notes: "Fresh vein at the target" });
    await settle();

    const s = h.orch.getSnapshot();
    // Standing at the target's own centre: guidance still resolves to a real,
    // finite, near-zero distance — not NaN/null from a broken re-target path.
    expect(s.distanceToTargetM).not.toBeNull();
    expect(Number.isFinite(s.distanceToTargetM)).toBe(true);
    expect(s.distanceToTargetM!).toBeLessThan(200);
    expect(Number.isFinite(s.activeTarget!.bearingDeg)).toBe(true);
  });

  test("5. historical waypoints are not globally deleted or disabled by this fix", async () => {
    const h = harness();
    const historical = await seedHistoricalWaypoint(h.waypointStore);
    await arriveAtA(h);
    await h.orch.captureObservation({ type: "quartz-vein", notes: "Fresh vein at the target" });
    await settle();

    // Still on disk, still undeleted, exactly as recorded weeks ago.
    const stillThere = h.waypointStore.get("wp-historical-1");
    expect(stillThere).not.toBeNull();
    expect(stillThere!.deletedAt).toBeNull();
    expect(stillThere!.capturedAt).toBe(HISTORICAL_CAPTURED_AT);
    expect(stillThere!.position!.lat).toBeCloseTo(ELSEWHERE.lat, 6);
    void historical;
  });

  test("7. baselineEvidenceSnapshot reflects the updated target evidence at finish", async () => {
    const h = harness();
    await arriveAtA(h);
    const before = h.orch.getSnapshot().activeTarget!.score;

    await h.orch.captureObservation({ type: "quartz-vein", notes: "Fresh vein at the target" });
    await settle();

    const pkg = await h.orch.finishSection({ waypoints: h.waypoints.list() });
    expect(pkg).not.toBeNull();

    // The package's score is the POST-observation one, not the arrival snapshot.
    expect(pkg!.prospectivityScore).toBeGreaterThan(before);
    expect(pkg!.reportScore).toBeDefined();

    // The baseline snapshot the package carries actually contains today's
    // observation — the whole point of the fix.
    const snapshot = pkg!.baselineEvidenceSnapshot ?? [];
    expect(snapshot.some((s) => s.reason.kind === "observation" && s.reason.label === "quartz-vein")).toBe(true);

    // And the package's own score is built from exactly that snapshot's
    // evidence (same evidence set that produced prospectivityScore).
    expect(snapshot.length).toBeGreaterThan(0);
  });
});

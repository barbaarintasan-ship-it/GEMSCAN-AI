// THE QARDHO / BORAMA BUG — geology must be assessed where the EVIDENCE is.
//
// The user is physically in Qardho (≈49.09 E). A colleague sends photographs and a
// coordinate from Borama (≈43.18 E) — about 650 km west. In ADD WAYPOINT they pick
// "Reported to me" and type the Borama coordinate.
//
// Before the fix, the geology engine read the LIVE GPS (`activePoint()` / `snap.
// position`), so the fault distance, the mapped unit, the elevation, the target
// cell and the prospectivity score were all computed around Qardho — the ground the
// phone was standing on, not the ground the evidence came from. The report was for
// the wrong place.
//
// These tests drive the REAL orchestrator, targeting engine, pack, waypoint store
// and package store — only the sensors and the clock are doubled — and prove:
//
//   • REPORTED: every location-dependent reading is measured at Borama, and NOT
//     ONE at Qardho.
//   • OBSERVED: the phone's own position is still the evidence location, unchanged.
//   • NAVIGATION: guidance to the reported site is still measured from the live fix.
import type { FieldFix, SessionSnapshot } from "../field/types";
import { buildPack } from "../../../shared/geo-core/pack/build.ts";
import type { PackData } from "../../../shared/geo-core/pack/types.ts";
import { PackStore, createBundledPackSource } from "../geo/packStore.ts";
import { OfflineGeoContextService } from "../geo/offlineGeoContext.ts";
import { TargetingEngine } from "../geo/targeting.ts";
import { cellCentre } from "../geo/h3.ts";
import { cellFor } from "../geo/h3.ts";
import { nearestLineOfKind, terrainAt, unitAt } from "../geo/featureInfo";
import { haversineM } from "../../../shared/geo-core/geo/spatial.ts";
import { ExplorationOrchestrator, type FieldSessionPort } from "../exploration/orchestrator.ts";
import { WaypointStore } from "../field/waypointStore";
import { WaypointService } from "../field/waypointService";
import { PhotoUploadQueue } from "../sync/photoUploadQueue";
import { PackageStore } from "../exploration/packageStore";
import { Outbox, type KeyValueAdapter } from "../sync/outbox";
import { positionReported } from "../field/waypointTypes";

const NOW = Date.parse("2026-08-17T09:00:00.000Z");
const BUILD_OPTS = {
  packId: "somalia", packVersion: "1.0.0", engineVersion: "1.0.0", region: "SO",
  h3Resolution: 7, builtAt: "2026-08-01T00:00:00.000Z",
  datasets: [{ datasetId: "d1", source: "USGS MRDS", version: "2024" }],
};

// The phone, and the evidence — 650 km apart.
const QARDHO = { lat: 9.51, lng: 49.09 };
const BORAMA = { lat: 9.94, lng: 43.18 };

/** A pack whose geology at Qardho and at Borama is deliberately DIFFERENT, so a
 *  lookup at the wrong place produces visibly wrong numbers. */
function pack(): PackData {
  const gold = (tag: string, c: { lat: number; lng: number }) =>
    Array.from({ length: 4 }, (_, i) => ({
      id: `${tag}${i}`, name: `${tag} Gold ${i}`, commodity_key: "gold",
      deposit_type: "orogenic", host_rocks: ["greenstone"],
      lat: c.lat + i * 0.001, lng: c.lng + i * 0.001,
      dataset_id: "d1", source: "USGS MRDS", version: "2024", reference: `R${tag}${i}`, cell: "c",
    }));

  return {
    geology: [
      {
        id: "g-qardho", name: "Qardho Basement", kind: "metamorphic", source: "Macrostrat",
        attributes: null,
        rings: [[[48.9, 9.3], [49.3, 9.3], [49.3, 9.7], [48.9, 9.7], [48.9, 9.3]]],
        bbox: [48.9, 9.3, 49.3, 9.7], isPolygon: true,
      },
      {
        id: "g-borama", name: "Borama Volcanics", kind: "volcanic", source: "Macrostrat",
        attributes: null,
        rings: [[[43.0, 9.8], [43.4, 9.8], [43.4, 10.1], [43.0, 10.1], [43.0, 9.8]]],
        bbox: [43.0, 9.8, 43.4, 10.1], isPolygon: true,
      },
    ],
    occurrences: [...gold("q", QARDHO), ...gold("b", BORAMA)],
    knowledge: [], structures: [], community: [],
    mapFeatures: [
      {
        id: "f-qardho", kind: "fault", name: "Qardho Fault", source: "GSS", attributes: null,
        lines: [[[49.16, 9.4], [49.16, 9.6]]], bbox: [49.16, 9.4, 49.16, 9.6],
      },
      {
        id: "f-borama", kind: "fault", name: "Borama Fault", source: "GSS", attributes: null,
        lines: [[[43.35, 9.85], [43.35, 10.0]]], bbox: [43.35, 9.85, 43.35, 10.0],
      },
    ],
    terrain: [
      {
        cell: cellFor(QARDHO.lat, QARDHO.lng), lat: QARDHO.lat, lng: QARDHO.lng,
        elevationM: 400, slopeDeg: 3, aspectDeg: 90, reliefM: 40, morphology: "flat", drainageDistM: 2000,
      },
      {
        cell: cellFor(BORAMA.lat, BORAMA.lng), lat: BORAMA.lat, lng: BORAMA.lng,
        elevationM: 1400, slopeDeg: 12, aspectDeg: 200, reliefM: 260, morphology: "slope", drainageDistM: 500,
      },
    ],
    associations: [], rules: [], commodities: [], assemblages: [], land: [],
  };
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
  const port: FieldSessionPort & {
    emitFix: (lat: number, lng: number) => void; emitHeading: (deg: number) => void;
  } = {
    getSnapshot: () => snap,
    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
    start: () => {
      snap = { ...snap, machine: { state: "active", pausedBy: null, errorCode: null }, sessionId: "ex-1", startedAt: NOW };
      listeners.forEach((l) => l());
    },
    stop: () => { snap = { ...snap, machine: { state: "idle", pausedBy: null, errorCode: null } }; listeners.forEach((l) => l()); },
    emitFix: (lat, lng) => {
      const fix: FieldFix = { lat, lng, accuracy: 6, altitude: 704, speed: 1, timestamp: NOW, provisional: false };
      snap = { ...snap, lastFix: fix, fixCount: snap.fixCount + 1 };
      listeners.forEach((l) => l());
    },
    emitHeading: (deg) => {
      snap = { ...snap, lastHeading: { trueHeading: deg, magneticHeading: deg - 2, accuracy: 4, needsCalibration: false } };
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
  const targeting = new TargetingEngine(new OfflineGeoContextService(packs));
  const orch = new ExplorationOrchestrator({
    field, targeting, packs, now: () => NOW, waypoints, photoUploads, packages, outbox,
  });
  return { orch, field, waypoints, packs, targeting };
}

/** Ground truth: what the engine's own functions say at each place, computed
 *  independently of the orchestrator. */
function groundTruth(h: ReturnType<typeof harness>) {
  const data = h.packs.getData()!;
  return {
    qFault: nearestLineOfKind(data, QARDHO, "fault")!.distanceM,
    bFault: nearestLineOfKind(data, BORAMA, "fault")!.distanceM,
    qElev: terrainAt(data, QARDHO)!.elevationM,
    bElev: terrainAt(data, BORAMA)!.elevationM,
    qUnit: unitAt(data, QARDHO)!.name,
    bUnit: unitAt(data, BORAMA)!.name,
  };
}

/** Phone in Qardho; a colleague's evidence reported from Borama. */
async function reportedFromBorama(h: ReturnType<typeof harness>) {
  h.orch.start();
  h.field.emitHeading(118);
  h.field.emitFix(QARDHO.lat, QARDHO.lng);
  await settle();
  const wp = await h.orch.captureObservation({
    type: "quartz-vein", notes: "Quartz vein by the tog — colleague's photographs",
    origin: "reported",
    position: positionReported(BORAMA.lat, BORAMA.lng, NOW),
  });
  await settle();
  const pkg = await h.orch.finishSection({ waypoints: h.waypoints.list() });
  return { wp, pkg };
}

/** Phone in Qardho; an ordinary on-the-ground observation. */
async function observedInQardho(h: ReturnType<typeof harness>) {
  h.orch.start();
  h.field.emitHeading(118);
  h.field.emitFix(QARDHO.lat, QARDHO.lng);
  await settle();
  const t = h.orch.getSnapshot().activeTarget!;
  h.orch.selectTarget(t.cell);
  await settle();
  const c = cellCentre(t.cell);
  h.field.emitFix(c.lat, c.lng);
  await settle();
  await settle();
  h.orch.beginInvestigation();
  // Stand exactly on the Qardho point, so the readings are unambiguously Qardho's.
  h.field.emitFix(QARDHO.lat, QARDHO.lng);
  await settle();
  await h.orch.captureObservation({ type: "outcrop", notes: "On the outcrop" });
  await settle();
  const pkg = await h.orch.finishSection({ waypoints: h.waypoints.list() });
  return { pkg };
}

describe("REPORTED: the geology is assessed at Borama, never at Qardho", () => {
  test("Test 1 — every location-dependent reading is Borama's, and zero are Qardho's", async () => {
    const h = harness();
    const { pkg } = await reportedFromBorama(h);
    expect(pkg).not.toBeNull();
    // Ground truth computed AFTER the pack has been loaded by the run above.
    const gt = groundTruth(h);
    // The fixture is only meaningful if the two places genuinely differ.
    expect(gt.bFault).not.toBeCloseTo(gt.qFault, 0);
    expect(gt.bElev).not.toBe(gt.qElev);
    expect(gt.bUnit).not.toBe(gt.qUnit);
    const er = pkg!.engineReadings!;

    // Fault distance — measured at Borama, not Qardho.
    expect(er.faultDistanceM).toBeCloseTo(gt.bFault, 0);
    expect(er.faultDistanceM).not.toBeCloseTo(gt.qFault, 0);
    // Elevation — Borama's DEM cell, not Qardho's.
    expect(er.elevationM).toBe(gt.bElev);
    expect(er.elevationM).not.toBe(gt.qElev);
    // Mapped geology — Borama's unit.
    expect(pkg!.geologyContext).toBe(gt.bUnit);
    expect(pkg!.geologyContext).not.toBe(gt.qUnit);
    // Target cell / centre — the reported point, not the device.
    expect(pkg!.targetCell).toBe(cellFor(BORAMA.lat, BORAMA.lng));
    expect(pkg!.targetCentre.lat).toBeCloseTo(BORAMA.lat, 3);
    expect(pkg!.targetCentre.lng).toBeCloseTo(BORAMA.lng, 3);
    // …and unambiguously NOT Qardho (≈6° of longitude away).
    expect(Math.abs(pkg!.targetCentre.lng - QARDHO.lng)).toBeGreaterThan(5);
    // Prospectivity was computed somewhere real.
    expect(pkg!.prospectivityScore).toBeGreaterThan(0);
    // The observation itself is still the reported coordinate, labelled reported.
    expect(pkg!.observations[0].origin).toBe("reported");
    expect(pkg!.observations[0].position!.lat).toBeCloseTo(BORAMA.lat, 5);
  });
});

describe("OBSERVED: the phone's position is still the evidence location", () => {
  test("Test 2 — an on-the-ground observation reads Qardho, exactly as before", async () => {
    const h = harness();
    const { pkg } = await observedInQardho(h);
    expect(pkg).not.toBeNull();
    const gt = groundTruth(h);
    const er = pkg!.engineReadings!;

    expect(er.faultDistanceM).toBeCloseTo(gt.qFault, 0);
    expect(er.elevationM).toBe(gt.qElev);
    expect(pkg!.geologyContext).toBe(gt.qUnit);
    // Nowhere near Borama.
    expect(pkg!.observations[0].origin ?? "observed").toBe("observed");
    expect(Math.abs(pkg!.targetCentre.lng - BORAMA.lng)).toBeGreaterThan(5);
  });
});

describe("Test 3 — the exact reported coordinate that was entered is what is used", () => {
  test("a coordinate typed just before Save is the one the package carries", async () => {
    const h = harness();
    // A point deliberately offset from the round Borama fixture, standing in for a
    // value the geologist edited in the box before pressing Save.
    const EDITED = { lat: 9.955, lng: 43.205 };
    h.orch.start();
    h.field.emitFix(QARDHO.lat, QARDHO.lng);
    await settle();
    await h.orch.captureObservation({
      type: "gossan", notes: "edited coordinate",
      origin: "reported",
      position: positionReported(EDITED.lat, EDITED.lng, NOW),
    });
    await settle();
    const pkg = await h.orch.finishSection({ waypoints: h.waypoints.list() });
    expect(pkg!.targetCentre.lat).toBeCloseTo(EDITED.lat, 5);
    expect(pkg!.targetCentre.lng).toBeCloseTo(EDITED.lng, 5);
    expect(pkg!.observations[0].position!.lat).toBeCloseTo(EDITED.lat, 5);
    expect(pkg!.observations[0].position!.lng).toBeCloseTo(EDITED.lng, 5);
  });
});

describe("Test 4 — navigation still runs from the live GPS", () => {
  test("guidance to the reported site is measured from the phone in Qardho", async () => {
    const h = harness();
    await reportedFromBorama(h);
    const snap = h.orch.getSnapshot();
    const qardhoToBorama = haversineM(QARDHO, BORAMA);
    // ~646 km: the distance from where the phone actually is to the reported site.
    // If navigation had wrongly used the reported coordinate as the origin, this
    // would collapse to near zero.
    expect(qardhoToBorama).toBeGreaterThan(600_000);
    expect(snap.distanceToTargetM).not.toBeNull();
    expect(snap.distanceToTargetM!).toBeGreaterThan(600_000);
    expect(snap.distanceToTargetM!).toBeLessThan(700_000);
  });
});

describe("Test 6 — a pinned reported investigation does not re-rank on every GPS fix", () => {
  // THE FREEZE THIS GUARDS AGAINST. `evidenceAt` pins the engine to the reported
  // cell, so `lastTargetedCell` becomes that cell — but onFieldChange compares it
  // against the PHONE's cell, which never matches, so retarget fired on every fix
  // and `targeting.rank` (~2.8 s each) pegged the JS thread continuously.
  test("moving the phone around Qardho after reporting Borama triggers no extra rank()", async () => {
    const h = harness();
    const rankSpy = jest.spyOn(h.targeting, "rank");

    h.orch.start();
    h.field.emitFix(QARDHO.lat, QARDHO.lng);
    await settle();
    await h.orch.captureObservation({
      type: "quartz-vein", notes: "colleague's photographs",
      origin: "reported",
      position: positionReported(BORAMA.lat, BORAMA.lng, NOW),
    });
    await settle();

    const ranksAfterReport = rankSpy.mock.calls.length;

    // The phone wanders across several DIFFERENT Qardho-area cells. Before the
    // guard, each of these would have triggered a full rank() — the storm.
    for (const d of [0.02, 0.04, 0.06, 0.08, 0.10]) {
      h.field.emitFix(QARDHO.lat + d, QARDHO.lng + d);
      await settle();
    }

    // Not one more rank() from the five fixes: the engine stays pinned to Borama.
    expect(rankSpy.mock.calls.length).toBe(ranksAfterReport);
    rankSpy.mockRestore();
  });

  test("an OBSERVED session still re-ranks when the phone changes cell", async () => {
    // The guard must be scoped to reported evidence only — ordinary field walking
    // must keep re-ranking as the geologist crosses into new ground.
    const h = harness();
    const rankSpy = jest.spyOn(h.targeting, "rank");
    h.orch.start();
    h.field.emitFix(QARDHO.lat, QARDHO.lng);
    await settle();
    const before = rankSpy.mock.calls.length;
    // Walk into a clearly different cell.
    h.field.emitFix(QARDHO.lat + 0.1, QARDHO.lng + 0.1);
    await settle();
    expect(rankSpy.mock.calls.length).toBeGreaterThan(before);
    rankSpy.mockRestore();
  });
});

describe("Test 5 — the built package's engine coordinates equal the reported position", () => {
  test("targetCentre and the observation position are Borama, device GPS is not substituted", async () => {
    const h = harness();
    const { pkg } = await reportedFromBorama(h);
    // The engine summary the AI will read (targetCell/centre) is the reported site.
    expect(pkg!.targetCell).toBe(cellFor(BORAMA.lat, BORAMA.lng));
    expect(pkg!.targetCentre.lng).toBeCloseTo(BORAMA.lng, 3);
    // The device's real position (Qardho, 49.09 E) never leaked into the package.
    expect(pkg!.targetCentre.lng).not.toBeCloseTo(QARDHO.lng, 1);
    expect(pkg!.engineReadings!.faultDistanceM).not.toBeCloseTo(
      nearestLineOfKind(h.packs.getData()!, QARDHO, "fault")!.distanceM, 0,
    );
  });
});

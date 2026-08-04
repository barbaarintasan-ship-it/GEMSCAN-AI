// ExplorationOrchestrator (Stage E4) — the loop, steps 1–8.
//
// The field session is a fake implementing the same port FieldSessionController
// satisfies, so the loop is testable without sensors — and so these tests prove
// the orchestrator COMPOSES over Phase 1 rather than reimplementing it.
import type { FieldFix, FieldHeading, SessionSnapshot } from "../field/types";
import { buildPack } from "../../../shared/geo-core/pack/build.ts";
import type { PackData } from "../../../shared/geo-core/pack/types.ts";
import { PackStore, createBundledPackSource } from "../geo/packStore.ts";
import { OfflineGeoContextService } from "../geo/offlineGeoContext.ts";
import { TargetingEngine } from "../geo/targeting.ts";
import {
  ExplorationOrchestrator,
  arrivalRadiusM,
  relativeBearing,
  type FieldSessionPort,
} from "../exploration/orchestrator.ts";

const MOG = { lat: 2.0469, lng: 45.3182 };
const NOW = Date.parse("2026-08-03T00:00:00.000Z");

const BUILD_OPTS = {
  packId: "somalia", packVersion: "1.0.0", engineVersion: "1.0.0", region: "SO",
  h3Resolution: 7, builtAt: "2026-08-01T00:00:00.000Z",
  datasets: [{ datasetId: "d1", source: "USGS MRDS", version: "2024" }],
};

function packWithNeCluster(): PackData {
  const d: PackData = {
    geology: [{
      id: "g1", name: "Precambrian Basement", kind: "formation", source: "Macrostrat",
      attributes: null,
      rings: [[[45.0, 1.8], [45.8, 1.8], [45.8, 2.6], [45.0, 2.6], [45.0, 1.8]]],
      bbox: [45.0, 1.8, 45.8, 2.6], isPolygon: true,
    }],
    occurrences: [], knowledge: [], structures: [], community: [], mapFeatures: [], terrain: [],
    associations: [], rules: [], commodities: [], assemblages: [], land: [],
  };
  for (let i = 0; i < 4; i++) {
    d.occurrences.push({
      id: `o${i}`, name: `NE Gold ${i}`, commodity_key: "gold", deposit_type: "orogenic",
      host_rocks: ["greenstone"], lat: MOG.lat + 0.025 + i * 0.002, lng: MOG.lng + 0.025 + i * 0.002,
      dataset_id: "d1", source: "USGS MRDS", version: "2024", reference: `M${i}`, cell: "c",
    });
  }
  return d;
}

// ── Fake field session (the Phase 1 port) ───────────────────────────────────
function fakeField() {
  const listeners = new Set<() => void>();
  let snap: SessionSnapshot = {
    machine: { state: "idle", pausedBy: null, errorCode: null },
    sessionId: null, startedAt: null, lastFix: null, lastHeading: null,
    fixCount: 0, headingSupported: true, degradedAccuracy: false, permission: null,
  };
  const port: FieldSessionPort & {
    emitFix: (lat: number, lng: number, accuracy?: number) => void;
    emitHeading: (deg: number) => void;
    setState: (s: SessionSnapshot["machine"]["state"]) => void;
    started: number; stopped: number;
  } = {
    started: 0, stopped: 0,
    getSnapshot: () => snap,
    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
    start: () => {
      port.started++;
      snap = { ...snap, machine: { state: "active", pausedBy: null, errorCode: null }, sessionId: "fs-1", startedAt: NOW };
      listeners.forEach((l) => l());
    },
    stop: () => {
      port.stopped++;
      snap = { ...snap, machine: { state: "idle", pausedBy: null, errorCode: null } };
      listeners.forEach((l) => l());
    },
    emitFix: (lat, lng, accuracy = 8) => {
      const fix: FieldFix = { lat, lng, accuracy, altitude: null, speed: null, timestamp: NOW, provisional: false };
      snap = { ...snap, lastFix: fix, fixCount: snap.fixCount + 1 };
      listeners.forEach((l) => l());
    },
    emitHeading: (deg) => {
      const h: FieldHeading = { trueHeading: deg, magneticHeading: deg, accuracy: 3, needsCalibration: false };
      snap = { ...snap, lastHeading: h };
      listeners.forEach((l) => l());
    },
    setState: (s) => {
      snap = { ...snap, machine: { ...snap.machine, state: s, pausedBy: s === "paused" ? "user" : null } };
      listeners.forEach((l) => l());
    },
  };
  return port;
}

function harness(data: PackData | null = packWithNeCluster()) {
  const files = data ? buildPack(data, BUILD_OPTS).files : null;
  const packs = new PackStore(createBundledPackSource(() => files), () => NOW);
  const targeting = new TargetingEngine(new OfflineGeoContextService(packs));
  const field = fakeField();
  const orch = new ExplorationOrchestrator({ field, targeting, packs, now: () => NOW });
  return { orch, field, packs };
}

/** Drain the orchestrator's async re-target. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

// ── Pure helpers ────────────────────────────────────────────────────────────
describe("guidance geometry", () => {
  // The orchestrator no longer carries its own copy of this rule; it re-exports
  // the one in geo/fixQuality, so a tight fix earns a tight arrival instead of
  // being told it has arrived from a flat 50 m away.
  test("arrival radius scales with GPS accuracy so it cannot flap", () => {
    expect(arrivalRadiusM(5)).toBe(25);    // floor — a good fix arrives close
    expect(arrivalRadiusM(40)).toBe(100);  // 2.5x accuracy
    expect(arrivalRadiusM(400)).toBe(150); // ceiling — never a whole village
    expect(arrivalRadiusM(null)).toBe(50); // unreported accuracy: assume 20 m
  });

  test("relative bearing is a signed turn, shortest way round", () => {
    expect(relativeBearing(90, 0)).toBe(90);    // turn right
    expect(relativeBearing(0, 90)).toBe(-90);   // turn left
    expect(relativeBearing(350, 10)).toBe(-20); // across north, not +340
    expect(relativeBearing(10, 350)).toBe(20);
    // An about-face: the sign is arbitrary, both turns are 180 degrees.
    expect(Math.abs(relativeBearing(180, 0))).toBe(180);
  });
});

// ── The loop ────────────────────────────────────────────────────────────────
describe("ExplorationOrchestrator", () => {
  test("step 1: start begins the FIELD session — it does not open its own", async () => {
    const { orch, field } = harness();
    orch.start();
    expect(field.started).toBe(1);
    expect(orch.getSnapshot().state).toBe("orienting");
    expect(orch.getSnapshot().explorationSessionId).toBeTruthy();
    orch.stop();
  });

  test("steps 2–3: a first fix orients, then recommends a target with reasons", async () => {
    const { orch, field } = harness();
    orch.start();
    field.emitFix(MOG.lat, MOG.lng);
    await settle();

    const s = orch.getSnapshot();
    expect(s.state).toBe("guiding");
    expect(s.currentCell).toBeTruthy();
    expect(s.context!.geology.unit).toBe("Precambrian Basement");
    expect(s.activeTarget).not.toBeNull();
    expect(s.activeTarget!.reasons.length).toBeGreaterThan(0);
    expect(s.hasKnowledge).toBe(true);
    expect(s.packProvenance!.packVersion).toBe("1.0.0");
    orch.stop();
  });

  test("step 4: re-targets on a CELL change, not on every fix", async () => {
    const { orch, field } = harness();
    orch.start();
    field.emitFix(MOG.lat, MOG.lng);
    await settle();
    const first = orch.getSnapshot().activeTarget;

    // Several fixes a few metres apart — same H3 cell.
    for (let i = 1; i <= 5; i++) {
      field.emitFix(MOG.lat + i * 0.00002, MOG.lng);
      await settle();
    }
    // The recommendation is stable: same target object identity.
    expect(orch.getSnapshot().activeTarget).toBe(first);
    orch.stop();
  });

  test("step 4: heading gives a relative turn; absent heading does not block guidance", async () => {
    const { orch, field } = harness();
    orch.start();
    field.emitFix(MOG.lat, MOG.lng);
    await settle();
    expect(orch.getSnapshot().relativeBearingDeg).toBeNull(); // no heading yet
    expect(orch.getSnapshot().activeTarget!.bearingDeg).toBeGreaterThanOrEqual(0);

    field.emitHeading(0); // facing north
    await settle();
    const rel = orch.getSnapshot().relativeBearingDeg!;
    expect(rel).not.toBeNull();
    expect(Math.abs(rel)).toBeLessThanOrEqual(180);
    orch.stop();
  });

  test("step 5: arriving at the target requests evidence", async () => {
    const { orch, field } = harness();
    orch.start();
    field.emitFix(MOG.lat, MOG.lng);
    await settle();
    const target = orch.getSnapshot().activeTarget!;

    // Stand on the target.
    field.emitFix(target.centre.lat, target.centre.lng);
    await settle();
    expect(orch.getSnapshot().state).toBe("awaitingEvidence");
    orch.stop();
  });

  test("steps 6–7: recording evidence re-scores and counts it", async () => {
    const { orch, field } = harness();
    orch.start();
    field.emitFix(MOG.lat, MOG.lng);
    await settle();

    await orch.recordEvidence();
    await settle();
    const s = orch.getSnapshot();
    expect(s.evidenceCount).toBe(1);
    expect(["guiding", "orienting"]).toContain(s.state);
    orch.stop();
  });

  test("guidance SUSPENDS with the field session and resumes with it", async () => {
    const { orch, field } = harness();
    orch.start();
    field.emitFix(MOG.lat, MOG.lng);
    await settle();
    expect(orch.getSnapshot().suspendedBy).toBeNull();

    field.setState("paused");
    await settle();
    expect(orch.getSnapshot().suspendedBy).toBe("paused");

    field.setState("active");
    await settle();
    expect(orch.getSnapshot().suspendedBy).toBeNull();
    orch.stop();
  });

  test("a sensor error suspends guidance rather than inventing a position", async () => {
    const { orch, field } = harness();
    orch.start();
    field.emitFix(MOG.lat, MOG.lng);
    await settle();
    field.setState("error");
    await settle();
    expect(orch.getSnapshot().suspendedBy).toBe("sensor-error");
    orch.stop();
  });

  test("before any fix, guidance waits — it does not guess a location", async () => {
    const { orch } = harness();
    orch.start();
    await settle();
    const s = orch.getSnapshot();
    expect(s.suspendedBy).toBe("no-fix");
    expect(s.activeTarget).toBeNull();
    expect(s.currentCell).toBeNull();
    orch.stop();
  });

  test("with no pack it guides nobody anywhere and says so", async () => {
    const { orch, field } = harness(null);
    orch.start();
    field.emitFix(MOG.lat, MOG.lng);
    await settle();
    const s = orch.getSnapshot();
    expect(s.hasKnowledge).toBe(false);
    expect(s.targets).toEqual([]);
    expect(s.activeTarget).toBeNull();
    expect(s.packProvenance).toBeNull();
    orch.stop();
  });

  test("the user can choose a different target from the ranked list", async () => {
    const { orch, field } = harness();
    orch.start();
    field.emitFix(MOG.lat, MOG.lng);
    await settle();
    const s = orch.getSnapshot();
    if (s.targets.length > 1) {
      orch.selectTarget(s.targets[1].cell);
      expect(orch.getSnapshot().activeTarget!.cell).toBe(s.targets[1].cell);
    }
    orch.selectTarget("not-a-cell"); // ignored, never throws
    orch.stop();
  });

  test("step 8: stop ends the session and stops the FIELD session", async () => {
    const { orch, field } = harness();
    orch.start();
    field.emitFix(MOG.lat, MOG.lng);
    await settle();
    orch.stop();

    const s = orch.getSnapshot();
    expect(s.state).toBe("ended");
    expect(s.endedAt).toBe(NOW);
    expect(s.activeTarget).toBeNull();
    expect(field.stopped).toBe(1);
  });

  test("the traverse records which cells it decided from", async () => {
    const { orch, field } = harness();
    orch.start();
    field.emitFix(MOG.lat, MOG.lng);
    await settle();
    expect(orch.getSnapshot().visitedCells.length).toBeGreaterThan(0);
    orch.stop();
  });

  test("subscribers are notified, and snapshot identity is stable between changes", async () => {
    const { orch, field } = harness();
    let calls = 0;
    const unsub = orch.subscribe(() => { calls++; });
    orch.start();
    expect(calls).toBeGreaterThan(0);

    const a = orch.getSnapshot();
    expect(orch.getSnapshot()).toBe(a);

    field.emitFix(MOG.lat, MOG.lng);
    await settle();
    expect(orch.getSnapshot()).not.toBe(a);

    unsub();
    const settled = calls;
    field.emitFix(MOG.lat + 0.00001, MOG.lng);
    await settle();
    expect(calls).toBe(settled);
    orch.stop();
  });

  test("start is ignored while already running, and destroy is safe from any state", async () => {
    const { orch, field } = harness();
    orch.start();
    orch.start();
    expect(field.started).toBe(1);
    orch.destroy();
    expect(field.stopped).toBe(1);
    orch.destroy(); // no throw
  });

  test("shows the real GPS position, with accuracy", async () => {
    const { orch, field } = harness();
    orch.start();
    field.emitFix(MOG.lat, MOG.lng, 12);
    await settle();
    const s = orch.getSnapshot();
    // Altitude and timestamp ride along with the fix now: the screen grades how
    // OLD a position is, and the track recorder needs a real altitude to
    // accumulate any relief at all.
    expect(s.position).toEqual({
      lat: MOG.lat, lng: MOG.lng, accuracyM: 12, altitudeM: null, timestamp: NOW,
    });
    expect(s.inspecting).toBeNull();
    orch.stop();
  });

  test("can look up a place the user is NOT standing at", async () => {
    const { orch, field } = harness();
    orch.start();
    field.emitFix(MOG.lat, MOG.lng);
    await settle();

    // Somewhere else entirely.
    orch.inspectAt(9.56, 44.065);
    await settle();
    const s = orch.getSnapshot();
    expect(s.inspecting).toEqual({ lat: 9.56, lng: 44.065 });
    // The real position is still reported — a lookup never overwrites it.
    expect(s.position).toEqual({
      lat: MOG.lat, lng: MOG.lng, accuracyM: 8, altitudeM: null, timestamp: NOW,
    });
    // No bearing or distance from a position you are not at.
    expect(s.distanceToTargetM).toBeNull();
    expect(s.relativeBearingDeg).toBeNull();
    orch.stop();
  });

  test("GPS movement does not hijack an active lookup", async () => {
    const { orch, field } = harness();
    orch.start();
    field.emitFix(MOG.lat, MOG.lng);
    await settle();
    orch.inspectAt(9.56, 44.065);
    await settle();

    // Walk a long way; the lookup must stand.
    field.emitFix(MOG.lat + 0.4, MOG.lng + 0.4);
    await settle();
    expect(orch.getSnapshot().inspecting).toEqual({ lat: 9.56, lng: 44.065 });
    orch.stop();
  });

  test("returning to my position clears the lookup", async () => {
    const { orch, field } = harness();
    orch.start();
    field.emitFix(MOG.lat, MOG.lng);
    await settle();
    orch.inspectAt(9.56, 44.065);
    await settle();
    orch.clearInspect();
    await settle();
    expect(orch.getSnapshot().inspecting).toBeNull();
    orch.stop();
  });

  // The upgrade's core behaviour at the engine level: a mapped feature further
  // away than one leg of a traverse is still somewhere you can be sent.
  test("navigates to a mapped feature at expedition range", async () => {
    const { orch, field } = harness();
    orch.start();
    field.emitFix(MOG.lat, MOG.lng);
    await settle();

    // Hargeisa-ish: roughly 900 km north-west of Mogadishu. Far beyond the
    // 15 km the targeting engine will recommend a walk to, and that is the point.
    const lead = {
      id: "occ:far-gold", kind: "occurrence" as const, label: "Gold showing",
      commodity: "Gold", lat: 9.56, lng: 44.065,
      distanceM: 900_000, bearingDeg: 315, compass: "NW",
      distanceClass: { band: "expedition" as const, transport: "expedition" as const, travelMinutes: 1_543 },
      priority: 0.2,
      reason: { kind: "known_occurrence" as const, commodity: "Gold" },
    };
    orch.navigateToRegional(lead);

    const s = orch.getSnapshot();
    expect(s.destination).toEqual({ lat: 9.56, lng: 44.065 });
    // The pack record travels WITH the destination, so the screen can say what
    // it is rather than presenting a bare coordinate.
    expect(s.selectedRegional?.id).toBe("occ:far-gold");
    // Measured from the real fix, and actually measured — not refused for range.
    expect(s.destinationDistanceM).toBeGreaterThan(800_000);
    expect(s.destinationBearingDeg).not.toBeNull();
    orch.stop();
  });

  test("clearing the destination also clears the record it came from", async () => {
    const { orch, field } = harness();
    orch.start();
    field.emitFix(MOG.lat, MOG.lng);
    await settle();

    orch.navigateTo(9.56, 44.065);
    expect(orch.getSnapshot().destination).not.toBeNull();
    orch.clearDestination();

    const s = orch.getSnapshot();
    expect(s.destination).toBeNull();
    expect(s.selectedRegional).toBeNull();
    expect(s.destinationDistanceM).toBeNull();
    orch.stop();
  });

  // A hand-typed coordinate is not a pack record, and must not inherit one from
  // whatever regional lead was being followed before it.
  test("a typed destination does not inherit the previous lead's identity", async () => {
    const { orch, field } = harness();
    orch.start();
    field.emitFix(MOG.lat, MOG.lng);
    await settle();

    orch.navigateToRegional({
      id: "occ:x", kind: "occurrence", label: "x", commodity: null,
      lat: 3, lng: 45, distanceM: 100_000, bearingDeg: 0, compass: "N",
      distanceClass: { band: "expedition", transport: "expedition", travelMinutes: 171 },
      priority: 0.1, reason: { kind: "known_occurrence", commodity: null },
    });
    orch.navigateTo(4, 46);

    expect(orch.getSnapshot().selectedRegional).toBeNull();
    expect(orch.getSnapshot().destination).toEqual({ lat: 4, lng: 46 });
    orch.stop();
  });

  test("reaching a target counts towards the traverse summary", async () => {
    const { orch, field } = harness();
    orch.start();
    field.emitFix(MOG.lat, MOG.lng);
    await settle();
    expect(orch.getSnapshot().targetsInvestigated).toBe(0);

    const target = orch.getSnapshot().activeTarget!;
    field.emitFix(target.centre.lat, target.centre.lng);
    await settle();

    expect(orch.getSnapshot().state).toBe("awaitingEvidence");
    expect(orch.getSnapshot().targetsInvestigated).toBe(1);
    orch.stop();
  });

  test("impossible coordinates are refused, not looked up", async () => {
    const { orch, field } = harness();
    orch.start();
    field.emitFix(MOG.lat, MOG.lng);
    await settle();
    orch.inspectAt(999, 0);
    orch.inspectAt(0, 999);
    orch.inspectAt(Number.NaN, 45);
    await settle();
    expect(orch.getSnapshot().inspecting).toBeNull();
    orch.stop();
  });
});

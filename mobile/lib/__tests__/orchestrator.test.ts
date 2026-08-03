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
    occurrences: [], knowledge: [], structures: [], community: [],
    associations: [], rules: [], commodities: [], assemblages: [],
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
  test("arrival radius widens with GPS accuracy so it cannot flap", () => {
    expect(arrivalRadiusM(5)).toBe(50);   // floor
    expect(arrivalRadiusM(40)).toBe(80);  // 2x accuracy
    expect(arrivalRadiusM(null)).toBe(50);
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
});

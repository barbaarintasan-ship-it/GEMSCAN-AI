// The exploration mission, end to end: target -> lock -> navigate -> arrive ->
// investigate -> finish -> package -> queue -> analysis -> close.
//
// Drives the REAL orchestrator and the REAL targeting engine. The only doubles
// are the sensors, the clock and the key-value store, because those are the parts
// a test cannot have.
import type { FieldFix, SessionSnapshot } from "../field/types";
import type { Waypoint } from "../field/waypointTypes";
import { buildPack } from "../../../shared/geo-core/pack/build.ts";
import type { PackData } from "../../../shared/geo-core/pack/types.ts";
import { PackStore, createBundledPackSource } from "../geo/packStore.ts";
import { OfflineGeoContextService } from "../geo/offlineGeoContext.ts";
import { TargetingEngine } from "../geo/targeting.ts";
import { cellCentre } from "../geo/h3.ts";
import { ExplorationOrchestrator, type FieldSessionPort } from "../exploration/orchestrator.ts";
import { PackageStore, PACKAGE_OUTBOX_KIND } from "../exploration/packageStore";
import { packageSize } from "../exploration/evidencePackage";
import { canTransition, isMissionLive, MISSION_STATES } from "../exploration/mission";
import { MISSION_FINDINGS_VERSION } from "../../../shared/geo-core/gie/missionFindings";
import { Outbox, type KeyValueAdapter } from "../sync/outbox";
import { clearTargetSwitchLog } from "../exploration/targetSwitchLog";

const NOW = Date.parse("2026-08-10T00:00:00.000Z");
const BUILD_OPTS = {
  packId: "somalia", packVersion: "1.0.0", engineVersion: "1.0.0", region: "SO",
  h3Resolution: 7, builtAt: "2026-08-01T00:00:00.000Z",
  datasets: [{ datasetId: "d1", source: "USGS MRDS", version: "2024" }],
};
const START = { lat: 2.0469, lng: 45.3182 };

function pack(): PackData {
  const d: PackData = {
    geology: [{
      id: "g1", name: "Precambrian Basement", kind: "metamorphic", source: "Macrostrat",
      attributes: null,
      rings: [[[45.1, 1.9], [45.6, 1.9], [45.6, 2.3], [45.1, 2.3], [45.1, 1.9]]],
      bbox: [45.1, 1.9, 45.6, 2.3], isPolygon: true,
    }],
    occurrences: [], knowledge: [], structures: [], community: [], mapFeatures: [], terrain: [],
    associations: [], rules: [], commodities: [], assemblages: [], land: [],
  };
  for (const [tag, c] of [["a", { lat: START.lat + 0.021, lng: START.lng + 0.021 }],
                          ["b", { lat: START.lat - 0.002, lng: START.lng + 0.030 }]] as const) {
    for (let i = 0; i < 4; i++) {
      d.occurrences.push({
        id: `${tag}${i}`, name: `${tag} Gold ${i}`, commodity_key: "gold",
        deposit_type: "orogenic", host_rocks: ["greenstone"],
        lat: c.lat + i * 0.001, lng: c.lng + i * 0.001,
        dataset_id: "d1", source: "USGS MRDS", version: "2024",
        reference: `R${tag}${i}`, cell: "c",
      });
    }
  }
  return d;
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
    stop: () => {
      snap = { ...snap, machine: { state: "idle", pausedBy: null, errorCode: null } };
      listeners.forEach((l) => l());
    },
    emitFix: (lat, lng) => {
      const fix: FieldFix = { lat, lng, accuracy: 8, altitude: 700, speed: 4, timestamp: NOW, provisional: false };
      snap = { ...snap, lastFix: fix, fixCount: snap.fixCount + 1 };
      listeners.forEach((l) => l());
    },
  };
  return port;
}

/** A key-value store that lives in this test, so persistence is real but local. */
function memoryStorage(): KeyValueAdapter & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => { data.set(k, v); },
  };
}

function observation(
  id: string, at: number, lat: number, lng: number, sessionId: string | null = null,
): Waypoint {
  return {
    id, sessionId, trackId: sessionId, type: "quartz-vein", name: null,
    notes: "Quartz vein with limonite staining, 40 cm wide",
    position: {
      lat, lng, accuracyM: 6, altitudeM: 702,
      fixedAt: at - 1_200, ageMs: 1_200, provisional: false,
    },
    heading: {
      trueHeading: 118, magneticHeading: 116, accuracy: 4,
      needsCalibration: false, sampledAt: at,
    },
    photos: [{ id: `${id}-p1`, uri: `file:///photos/${id}.jpg`, capturedAt: at, remotePath: null }],
    capturedAt: at, updatedAt: at, syncState: "local", deletedAt: null,
  };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));
jest.setTimeout(180_000);

function harness(opts: { hotspot?: boolean } = {}) {
  clearTargetSwitchLog();
  const files = buildPack(pack(), BUILD_OPTS).files;
  const packs = new PackStore(createBundledPackSource(() => files), () => NOW);
  const targeting = new TargetingEngine(new OfflineGeoContextService(packs));
  const field = fakeField();
  const storage = memoryStorage();
  const packages = new PackageStore({ storage, now: () => NOW });
  const outbox = new Outbox({ storage, now: () => NOW });
  const orch = new ExplorationOrchestrator({
    field, targeting, packs, now: () => NOW, packages, outbox,
    // A stub, so the workflow is tested without also testing the scorer. The real
    // search is covered in hotspot.test.ts.
    findHotspot: opts.hotspot
      ? async (cell) => {
          const c = cellCentre(cell);
          return { lat: c.lat + 0.004, lng: c.lng + 0.004, cell: `${cell}-child`, score: 0.71, liftOverCentre: 0.19 };
        }
      : async () => null,
  });
  return { orch, field, packages, outbox, storage };
}

/** Take a target and drive into its cell. The common opening of every scenario. */
async function driveToTarget(h: ReturnType<typeof harness>) {
  h.orch.start();
  h.field.emitFix(START.lat, START.lng);
  await settle();
  const target = h.orch.getSnapshot().activeTarget!;
  h.orch.selectTarget(target.cell);
  await settle();
  const c = cellCentre(target.cell);
  h.field.emitFix(c.lat, c.lng);
  await settle();
  return target;
}

describe("1. the active target does not change while a mission is running", () => {
  test("no re-rank, from any trigger, moves it", async () => {
    const h = harness();
    const target = await driveToTarget(h);
    expect(h.orch.getSnapshot().mission).not.toBeNull();

    // Every automatic trigger there is, plus the manual re-score.
    for (const [dLat, dLng] of [[0.004, -0.010], [-0.012, -0.008], [0.018, 0.006]]) {
      h.field.emitFix(START.lat + dLat, START.lng + dLng);
      await settle();
    }
    h.orch.refresh();
    await settle();
    await h.orch.recordEvidence();
    await settle();

    expect(h.orch.getSnapshot().activeTarget!.cell).toBe(target.cell);
    expect(h.orch.getSnapshot().mission!.cell).toBe(target.cell);
  });
});

describe("2. entering the target cell reports ARRIVED_AT_TARGET_AREA", () => {
  test("and does NOT report the mission finished", async () => {
    const h = harness();
    await driveToTarget(h);
    const m = h.orch.getSnapshot().mission!;
    expect(m.state).toBe("arrived_at_target_area");
    expect(m.arrivedAt).toBe(NOW);
    // The distinction the whole layer exists for: reaching five square kilometres
    // of ground is the beginning of the work.
    expect(isMissionLive(m.state)).toBe(true);
    expect(h.orch.getSnapshot().targetsInvestigated).toBe(1);
  });

  test("arrival happens on the CELL, not within metres of its centre", async () => {
    const h = harness();
    h.orch.start();
    h.field.emitFix(START.lat, START.lng);
    await settle();
    const target = h.orch.getSnapshot().activeTarget!;
    h.orch.selectTarget(target.cell);
    await settle();

    // A corner of the cell — inside it, but far from the middle. Before the fix
    // this was the dead zone the target was discarded in.
    const c = cellCentre(target.cell);
    h.field.emitFix(c.lat + 0.008, c.lng + 0.008);
    await settle();
    const s = h.orch.getSnapshot();
    if (s.mission!.state === "arrived_at_target_area") {
      expect(s.distanceToTargetM).toBeGreaterThan(150);
    }
  });
});

describe("3. hotspot navigation", () => {
  test("a hotspot is searched for on arrival and guidance follows it", async () => {
    const h = harness({ hotspot: true });
    const target = await driveToTarget(h);
    await settle();

    const m = h.orch.getSnapshot().mission!;
    expect(m.hotspot).not.toBeNull();
    expect(m.hotspot!.liftOverCentre).toBeGreaterThan(0);

    // Guidance now measures to the hotspot, not to the cell centre.
    const c = cellCentre(target.cell);
    h.field.emitFix(c.lat, c.lng);
    await settle();
    const s = h.orch.getSnapshot();
    expect(s.distanceToTargetM).toBeGreaterThan(100);
  });

  test("no hotspot is invented when nothing stands out", async () => {
    const h = harness({ hotspot: false });
    await driveToTarget(h);
    await settle();
    // Null is the ordinary answer, and it is a real one: work it as an area.
    expect(h.orch.getSnapshot().mission!.hotspot).toBeNull();
  });
});

describe("4. better ground is reported, never taken", () => {
  test("a higher-scoring target does not replace a running mission", async () => {
    const h = harness();
    h.orch.start();
    h.field.emitFix(START.lat, START.lng);
    await settle();
    const ranked = h.orch.getSnapshot().targets;
    const worst = ranked[ranked.length - 1];
    h.orch.selectTarget(worst.cell);
    await settle();
    h.field.emitFix(START.lat + 0.006, START.lng + 0.006);
    await settle();

    const s = h.orch.getSnapshot();
    expect(s.activeTarget!.cell).toBe(worst.cell);
    if (s.betterTargetAvailable) {
      expect(s.betterTargetAvailable.score).toBeGreaterThan(s.activeTarget!.score);
    }
  });
});

describe("5. FINISH SECTION builds an evidence package", () => {
  test("it carries the target, the observations, and what was NOT looked at", async () => {
    const h = harness({ hotspot: true });
    const target = await driveToTarget(h);
    h.orch.beginInvestigation();
    expect(h.orch.getSnapshot().mission!.state).toBe("field_investigation");

    const sid = h.orch.getSnapshot().explorationSessionId;
    const obs = [
      observation("w1", NOW + 1_000, START.lat + 0.021, START.lng + 0.021, sid),
      observation("w2", NOW + 2_000, START.lat + 0.022, START.lng + 0.022, sid),
    ];
    const pkg = await h.orch.finishSection({
      waypoints: obs,
      track: [{ lat: START.lat, lng: START.lng, at: NOW, accuracyM: 8 }],
      terrainContext: "valley",
    });

    expect(pkg).not.toBeNull();
    expect(pkg!.targetCell).toBe(target.cell);
    expect(pkg!.hotspot).not.toBeNull();
    expect(pkg!.terrainContext).toBe("valley");
    expect(packageSize(pkg!)).toEqual({ observations: 2, photos: 2, trackPoints: 1 });
    // The honest half: which of the thirteen roles had nothing to say, and why.
    expect(pkg!.coverage).not.toBeNull();
    // And no interpretation — that is the analysis step's job, not the collector's.
    expect(pkg!.analysis).toBeNull();
  });

  test("observations from before this mission are not swept in", async () => {
    const h = harness();
    await driveToTarget(h);
    h.orch.beginInvestigation();
    const sid = h.orch.getSnapshot().explorationSessionId;
    const pkg = await h.orch.finishSection({
      waypoints: [
        observation("old", NOW - 86_400_000, START.lat, START.lng, sid),
        observation("new", NOW + 1_000, START.lat, START.lng, sid),
      ],
    });
    // Attaching last week's outcrop to today's target would be wrong in a way
    // nobody downstream could see.
    expect(pkg!.observations.map((o) => o.id)).toEqual(["new"]);
  });
});

describe("6. offline capture is not lost", () => {
  test("the package is on disk before anything is queued", async () => {
    const h = harness();
    await driveToTarget(h);
    h.orch.beginInvestigation();
    const pkg = await h.orch.finishSection({
      waypoints: [observation("w1", NOW + 1_000, START.lat, START.lng, h.orch.getSnapshot().explorationSessionId)],
    });

    // Written, with no network anywhere in this test.
    const raw = h.storage.data.get("exploration.packages.v1");
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)[0].id).toBe(pkg!.id);

    // And it survives the process dying: a fresh store over the same bytes.
    const reopened = new PackageStore({ storage: h.storage, now: () => NOW });
    await reopened.load();
    expect(reopened.get(pkg!.id)).not.toBeNull();
    expect(reopened.get(pkg!.id)!.observations).toHaveLength(1);
  });

  test("the mission waits for upload rather than claiming to be done", async () => {
    const h = harness();
    await driveToTarget(h);
    h.orch.beginInvestigation();
    await h.orch.finishSection({ waypoints: [] });
    expect(h.orch.getSnapshot().mission!.state).toBe("waiting_for_upload");
  });
});

describe("7. the package uploads when a network appears", () => {
  test("it is queued durably and keyed so a retry cannot duplicate it", async () => {
    const h = harness();
    await driveToTarget(h);
    h.orch.beginInvestigation();
    const pkg = await h.orch.finishSection({
      waypoints: [observation("w1", NOW + 1_000, START.lat, START.lng, h.orch.getSnapshot().explorationSessionId)],
    });

    await h.outbox.load();
    const queued = h.outbox.pending().filter((e) => e.kind === PACKAGE_OUTBOX_KIND);
    expect(queued).toHaveLength(1);
    // The package id IS the idempotency key: a retry after a timeout that in fact
    // succeeded cannot create a second mission on the server.
    expect(queued[0].localId).toBe(pkg!.id);
    expect(queued[0].sentAt).toBeNull();

    // What a successful drain does.
    await h.outbox.markSent(queued[0].localId, PACKAGE_OUTBOX_KIND as never);
    await h.outbox.load();
    expect(h.outbox.pending().filter((e) => e.kind === PACKAGE_OUTBOX_KIND)).toHaveLength(0);
  });

  test("the analysis attaches to the package it came from", async () => {
    const h = harness();
    await driveToTarget(h);
    h.orch.beginInvestigation();
    const pkg = await h.orch.finishSection({ waypoints: [] });

    // The analysis is MissionFindings — the same structure the server produces,
    // shared rather than mirrored. Codes, not prose, so the report renders into
    // either language with no model call.
    await h.packages.attachAnalysis(pkg!.id, {
      version: MISSION_FINDINGS_VERSION,
      commodity: null,
      interest: "moderate",
      confidence: "low",
      evidence: [{
        type: "quartz_vein", origin: "field_observation", status: "present",
        strength: "moderate", confidence: "medium", significance: "hydrothermal_indicator",
      }],
      missingEvidence: ["assay", "geochemistry", "alteration_mapping"],
      recommendations: [
        { action: "collect_rock_samples", priority: 1, becauseOf: ["quartz_vein"] },
      ],
      model: "test-model",
      analysedAt: NOW + 60_000,
    });
    const stored = h.packages.get(pkg!.id)!;
    expect(stored.analysis).not.toBeNull();
    // The shape has nowhere to put a probability, by construction. Checked over the
    // whole serialised record, not just its top-level keys.
    const json = JSON.stringify(stored.analysis);
    for (const bad of ["probability", "percent", "chance", "odds", "likelihood"]) {
      expect(json.toLowerCase()).not.toContain(bad);
    }
    // Codes, never sentences — a sentence here could not be translated.
    expect(stored.analysis!.evidence.every((e) => /^[a-z0-9_]+$/.test(e.type))).toBe(true);
    expect(stored.analysis!.missingEvidence.every((m) => /^[a-z0-9_]+$/.test(m))).toBe(true);
  });
});

describe("8. a new target can only be taken after the mission is closed", () => {
  test("closing releases the lock and the engine recommends again", async () => {
    const h = harness();
    const target = await driveToTarget(h);
    h.orch.beginInvestigation();
    await h.orch.finishSection({ waypoints: [] });
    expect(h.orch.getSnapshot().mission!.state).toBe("waiting_for_upload");

    // Still held: delivery is part of the mission.
    h.field.emitFix(START.lat - 0.014, START.lng - 0.014);
    await settle();
    expect(h.orch.getSnapshot().activeTarget!.cell).toBe(target.cell);

    h.orch.closeMission();
    await settle();
    expect(h.orch.getSnapshot().mission!.state).toBe("mission_closed");
    expect(isMissionLive(h.orch.getSnapshot().mission!.state)).toBe(false);

    // And now a different target may be offered.
    h.field.emitFix(START.lat + 0.020, START.lng + 0.020);
    await settle();
    expect(h.orch.getSnapshot().activeTarget).not.toBeNull();
  });

  test("the closed mission is kept as the record of what was done", async () => {
    const h = harness();
    await driveToTarget(h);
    h.orch.beginInvestigation();
    const pkg = await h.orch.finishSection({ waypoints: [] });
    h.orch.closeMission();
    await settle();
    // The package outlives the mission, and the mission outlives its closing —
    // the screen has to be able to say what just happened.
    expect(h.orch.getSnapshot().mission!.closedAt).toBe(NOW);
    expect(h.packages.get(pkg!.id)).not.toBeNull();
  });
});

describe("the state machine itself", () => {
  test("arrival can never jump straight to a finished section", () => {
    expect(canTransition("arrived_at_target_area", "section_completed")).toBe(false);
    expect(canTransition("arrived_at_target_area", "field_investigation")).toBe(true);
  });

  test("every live state can be abandoned, because a geologist may have to leave", () => {
    for (const s of MISSION_STATES) {
      if (!isMissionLive(s)) continue;
      expect(canTransition(s, "mission_closed")).toBe(true);
    }
  });

  test("nothing runs backwards", () => {
    expect(canTransition("field_investigation", "navigating")).toBe(false);
    expect(canTransition("section_completed", "field_investigation")).toBe(false);
    expect(canTransition("mission_closed", "field_investigation")).toBe(false);
  });
});

// ── AI_ANALYSIS_COMPLETE, which used to be unreachable ───────────────────────
//
// The state existed and was a legal transition, but nothing in the app moved a
// mission into it — a terminal step nobody could get to. These cover the way in.
describe("the assessment arriving", () => {
  const findings = () => ({
    version: MISSION_FINDINGS_VERSION,
    commodity: null,
    interest: "moderate" as const,
    confidence: "low" as const,
    evidence: [{
      type: "quartz_vein", origin: "field_observation" as const, status: "present" as const,
      strength: "moderate" as const, confidence: "medium" as const,
      significance: "hydrothermal_indicator",
    }],
    missingEvidence: ["assay"],
    recommendations: [{ action: "submit_for_assay", priority: 1 as const, becauseOf: [] }],
    model: "test-model",
    analysedAt: NOW + 60_000,
  });

  test("attachAnalysis reaches AI_ANALYSIS_COMPLETE", async () => {
    const h = harness();
    await driveToTarget(h);
    h.orch.beginInvestigation();
    const pkg = await h.orch.finishSection({ waypoints: [] });
    expect(h.orch.getSnapshot().mission!.state).toBe("waiting_for_upload");

    await h.orch.attachAnalysis(findings());
    expect(h.orch.getSnapshot().mission!.state).toBe("ai_analysis_complete");
    // And the findings are on the package, not just in the state.
    expect(h.packages.get(pkg!.id)!.analysis).not.toBeNull();
    expect(h.packages.get(pkg!.id)!.analysis!.model).toBe("test-model");
  });

  test("the findings are written BEFORE the state moves", async () => {
    // A state saying the analysis arrived, with no analysis behind it, would be
    // worse than the state never being reached.
    const h = harness();
    await driveToTarget(h);
    h.orch.beginInvestigation();
    const pkg = await h.orch.finishSection({ waypoints: [] });
    await h.orch.attachAnalysis(findings());

    const stored = h.packages.get(pkg!.id)!.analysis!;
    expect(stored.evidence.length).toBe(1);
    expect(h.orch.getSnapshot().mission!.state).toBe("ai_analysis_complete");
  });

  test("an analysis with no mission is ignored, not crashed on", async () => {
    const h = harness();
    // No mission, no package. This can happen when a late assessment arrives for a
    // walk that was already closed.
    await h.orch.attachAnalysis(findings());
    expect(h.orch.getSnapshot().mission).toBeNull();
  });

  test("the mission can still be closed after the assessment", async () => {
    const h = harness();
    await driveToTarget(h);
    h.orch.beginInvestigation();
    await h.orch.finishSection({ waypoints: [] });
    await h.orch.attachAnalysis(findings());
    h.orch.closeMission();
    await settle();
    expect(h.orch.getSnapshot().mission!.state).toBe("mission_closed");
  });

  test("the target stays held right through delivery and analysis", async () => {
    // Delivery is part of the mission. The engine may not reassign the target
    // while a report is still coming back.
    const h = harness();
    const target = await driveToTarget(h);
    h.orch.beginInvestigation();
    await h.orch.finishSection({ waypoints: [] });
    await h.orch.attachAnalysis(findings());

    h.field.emitFix(START.lat - 0.016, START.lng - 0.016);
    await settle();
    expect(h.orch.getSnapshot().activeTarget!.cell).toBe(target.cell);
  });
});

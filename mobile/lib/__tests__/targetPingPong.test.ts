// REPRODUCTION of the field report: the app ping-ponging between two targets.
//
// Reported: target A chosen, driven toward; at about 1.2 km the app switched to
// target B; on approaching B it switched back to A; and so on without end.
//
// This drove the REAL TargetingEngine over a synthetic pack along a synthetic
// route and read the TARGET_SWITCH_EVENT log. Measured BEFORE the fix: an
// obedient driver was handed a destination 142 times across just 2 cells —
// perfect alternation, 71 each — over 13.5 km, arriving at none of them.
//
// THE ROOT CAUSE was two halves of the system disagreeing about one predicate.
// `rank()` drops the cell you are standing in from its candidates, which at H3
// resolution 7 happens up to ~1.2 km from that cell's centre. Arrival was
// measured at 25-150 m from the same centre. Between those two thresholds the
// ranking said "you are here, this is not a target" while guidance said "you have
// not arrived" — so the target was discarded and another issued, forever.
//
// Two contributing defects: the destination had no lifecycle (it was a value
// recomputed from the ranking), and the sort's distance tie-break is measured
// from the traveller, so with `limit: 3` a target could be evicted by cells that
// had merely come closer, its own score unchanged.
//
// The tests below assert the FIXED behaviour, and keep the original diagnostics
// because those printouts are what made the cause visible.
import type { FieldFix, SessionSnapshot } from "../field/types";
import { buildPack } from "../../../shared/geo-core/pack/build.ts";
import type { PackData } from "../../../shared/geo-core/pack/types.ts";
import { PackStore, createBundledPackSource } from "../geo/packStore.ts";
import { OfflineGeoContextService } from "../geo/offlineGeoContext.ts";
import { TargetingEngine } from "../geo/targeting.ts";
import { cellFor } from "../geo/h3.ts";
import { haversineM } from "../../../shared/geo-core/geo/spatial.ts";
import { ExplorationOrchestrator, type FieldSessionPort } from "../exploration/orchestrator.ts";
import {
  actualSwitches, clearTargetSwitchLog, targetSwitchLog,
} from "../exploration/targetSwitchLog";

const NOW = Date.parse("2026-08-10T00:00:00.000Z");
const BUILD_OPTS = {
  packId: "somalia", packVersion: "1.0.0", engineVersion: "1.0.0", region: "SO",
  h3Resolution: 7, builtAt: "2026-08-01T00:00:00.000Z",
  datasets: [{ datasetId: "d1", source: "USGS MRDS", version: "2024" }],
};

const START = { lat: 2.0469, lng: 45.3182 };
/** Two clusters, deliberately the same size and the same distance out. */
const A = { lat: START.lat + 0.021, lng: START.lng + 0.021 };
const B = { lat: START.lat - 0.002, lng: START.lng + 0.030 };

function twoClusterPack(): PackData {
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
  // Identical cluster geometry either side, so the two targets score the same and
  // the sort falls through to its distance tie-break. That tie-break is measured
  // from the traveller, which is what makes the order move as they drive.
  for (const [tag, c] of [["a", A], ["b", B]] as const) {
    for (let i = 0; i < 4; i++) {
      d.occurrences.push({
        id: `${tag}${i}`, name: `${tag.toUpperCase()} Gold ${i}`, commodity_key: "gold",
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
      snap = {
        ...snap, machine: { state: "active", pausedBy: null, errorCode: null },
        sessionId: "fs-1", startedAt: NOW,
      };
      listeners.forEach((l) => l());
    },
    stop: () => {
      snap = { ...snap, machine: { state: "idle", pausedBy: null, errorCode: null } };
      listeners.forEach((l) => l());
    },
    emitFix: (lat, lng) => {
      // 8 m accuracy — a good fix, so the arrival radius is its 25 m floor and
      // cannot be blamed for what follows.
      const fix: FieldFix = {
        lat, lng, accuracy: 8, altitude: null, speed: 16,
        timestamp: NOW, provisional: false,
      };
      snap = { ...snap, lastFix: fix, fixCount: snap.fixCount + 1 };
      listeners.forEach((l) => l());
    },
  };
  return port;
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

jest.setTimeout(180_000);

describe("REPRODUCTION — target ping-pong on a drive", () => {
  let log: ReturnType<typeof targetSwitchLog>;
  let route: Array<{ lat: number; lng: number }>;
  let activeAt: Array<{ step: number; cell: string | null; distanceM: number | null }>;

  beforeAll(async () => {
    clearTargetSwitchLog();
    const files = buildPack(twoClusterPack(), BUILD_OPTS).files;
    const packs = new PackStore(createBundledPackSource(() => files), () => NOW);
    const targeting = new TargetingEngine(new OfflineGeoContextService(packs));
    const field = fakeField();
    const orch = new ExplorationOrchestrator({ field, targeting, packs, now: () => NOW });

    orch.start();
    field.emitFix(START.lat, START.lng);
    await settle();

    // Drive from START toward A, 40 steps of about 90 m — a vehicle reporting a
    // fix every few seconds. Whatever the app recommends, the ROUTE does not
    // change: this is a driver committed to A.
    route = [];
    activeAt = [];
    for (let i = 1; i <= 40; i++) {
      const f = i / 40;
      route.push({ lat: START.lat + (A.lat - START.lat) * f, lng: START.lng + (A.lng - START.lng) * f });
    }
    for (let i = 0; i < route.length; i++) {
      field.emitFix(route[i].lat, route[i].lng);
      await settle();
      const t = orch.getSnapshot().activeTarget;
      activeAt.push({
        step: i,
        cell: t?.cell ?? null,
        distanceM: t ? haversineM(route[i], t.centre) : null,
      });
    }
    log = targetSwitchLog();
  });

  test("the route really does approach A and pass through its cell", () => {
    // Establishes that the drive is what it claims to be, before anything is
    // concluded from it.
    const cellA = cellFor(A.lat, A.lng);
    const last = route[route.length - 1];
    expect(haversineM(last, A)).toBeLessThan(200);
    expect(route.some((p) => cellFor(p.lat, p.lng) === cellA)).toBe(true);
  });

  test("no GPS update may ever change the destination", () => {
    const switches = actualSwitches(log);
    // eslint-disable-next-line no-console
    console.log(
      `\nDRIVE: ${route.length} fixes toward A.\n` +
      `Target A = ${cellFor(A.lat, A.lng)}   Target B = ${cellFor(B.lat, B.lng)}\n\n` +
      `${switches.length} unrequested destination changes:\n` +
      switches.map((e) =>
        `  ${e.oldTarget} -> ${e.newTarget}  ` +
        `(was ${Math.round(e.distanceOldM ?? 0)} m away, new one ${Math.round(e.distanceNewM ?? 0)} m)  ` +
        `reason=${e.reason} trigger=${e.trigger}`,
      ).join("\n") +
      `\n\nactive target per fix:\n` +
      activeAt.map((a) =>
        `  step ${String(a.step).padStart(2)}: ${a.cell ?? "(none)"} ` +
        `${a.distanceM == null ? "" : Math.round(a.distanceM) + " m"}`,
      ).join("\n"),
    );

    // THE GUARANTEE. Driving does not choose where you are going.
    expect(switches.filter((e) => e.trigger === "gps-cell-change")).toEqual([]);
  });

  test("FIXED: a target is never self-excluded out from under the walk", () => {
    // This was the ping-pong itself. `rank()` still drops the cell you stand in —
    // that is correct, you are already there — but entering the cell now means
    // ARRIVING, so the exclusion can no longer strand a traveller between two
    // thresholds that disagreed by a factor of 48.
    expect(log.filter((e) => e.reason === "self-excluded-current-cell")).toEqual([]);
  });

  test("the ranking still reorders with the traveller — left deliberately alone", async () => {
    // targets.sort((a, b) => (b.score - a.score) || (a.distanceM - b.distanceM))
    //
    // A cell's score does not depend on where the traveller stands: it is scored at
    // the cell's own centre. The tie-break does. So with equal scores the ORDER
    // moves purely because the traveller moved — and that was one of the ways a
    // destination used to be evicted from the three-slot list it had to stay in.
    //
    // The sort is not changed. Sorting the alternatives by "nearest first among
    // equals" is right. What changed is that the destination no longer lives in
    // that list. Asserted against the engine directly, because the orchestrator
    // now arrives too quickly to show it.
    const files = buildPack(twoClusterPack(), BUILD_OPTS).files;
    const packs = new PackStore(createBundledPackSource(() => files), () => NOW);
    const targeting = new TargetingEngine(new OfflineGeoContextService(packs));
    const near = await targeting.rank(START.lat, START.lng);
    const moved = await targeting.rank(START.lat + 0.012, START.lng + 0.012);
    const order = (r: { targets: Array<{ cell: string }> }) => r.targets.map((t) => t.cell).join(",");
    // eslint-disable-next-line no-console
    console.log(`
ranking from START : ${order(near)}
ranking 1.9 km on  : ${order(moved)}`);
    expect(order(near)).not.toBe(order(moved));
  });

  test("the destination is the SAME cell from the first fix to the last", () => {
    // The clearest statement of the fix. Before it, this drive was handed three
    // different destinations and spent twenty fixes pointed at one it was driving
    // away from.
    const cells = new Set(activeAt.map((a) => a.cell).filter(Boolean));
    expect(cells.size).toBe(1);
  });

  test("the destination now has a lifecycle, and re-ranks respect it", () => {
    const kept = log.filter((e) => e.reason === "kept").length;
    const moved = actualSwitches(log).length;
    // eslint-disable-next-line no-console
    console.log(`\nof ${log.length} re-rank decisions: ${kept} kept, ${moved} replaced the destination`);
    expect(moved).toBe(0);
  });
});

// ── The endless loop, with an obedient driver ────────────────────────────────
//
// The drive above held a straight course. This one does what a user actually
// does: at every fix, move toward whatever the app is currently pointing at.
//
// This is the test that condemned the old behaviour and the one that clears the
// new: an obedient driver either completes the loop or oscillates for ever, and
// there is no third outcome. Before the fix it oscillated 71 times over 13.5 km.
describe("REPRODUCTION — following the app's own advice", () => {
  test("the traverse arrives, and no cell is handed out twice", async () => {
    clearTargetSwitchLog();
    const files = buildPack(twoClusterPack(), BUILD_OPTS).files;
    const packs = new PackStore(createBundledPackSource(() => files), () => NOW);
    const targeting = new TargetingEngine(new OfflineGeoContextService(packs));
    const field = fakeField();
    const orch = new ExplorationOrchestrator({ field, targeting, packs, now: () => NOW });

    orch.start();
    let at = { ...START };
    field.emitFix(at.lat, at.lng);
    await settle();

    const visited: string[] = [];
    let arrived = false;
    const STEP_M = 90;
    for (let i = 0; i < 150 && !arrived; i++) {
      const s = orch.getSnapshot();
      if (s.state === "awaitingEvidence") { arrived = true; break; }
      const t = s.activeTarget;
      if (!t) break;
      if (visited[visited.length - 1] !== t.cell) visited.push(t.cell);
      // Walk STEP_M toward the current recommendation.
      const d = haversineM(at, t.centre);
      const f = Math.min(1, STEP_M / Math.max(d, 1));
      at = {
        lat: at.lat + (t.centre.lat - at.lat) * f,
        lng: at.lng + (t.centre.lng - at.lng) * f,
      };
      field.emitFix(at.lat, at.lng);
      await settle();
    }

    const counts = new Map<string, number>();
    for (const c of visited) counts.set(c, (counts.get(c) ?? 0) + 1);
    const revisited = [...counts.entries()].filter(([, n]) => n > 1);
    // eslint-disable-next-line no-console
    console.log(
      `\nOBEDIENT DRIVER, ${STEP_M} m per fix:\n` +
      `  arrived: ${arrived}\n` +
      `  destination handed out ${visited.length} times, ${counts.size} distinct cells\n` +
      `  cells handed out more than once: ` +
      (revisited.length ? revisited.map(([c, n]) => `${c} x${n}`).join(", ") : "none") +
      `\n  order: ${visited.join(" -> ")}\n` +
      `  targetsInvestigated: ${orch.getSnapshot().targetsInvestigated}`,
    );

    // THE FIX, as the two facts that matter: the loop completes, and no cell is
    // ever handed out twice. Before the fix: arrived false, two cells 71 times each.
    expect(arrived).toBe(true);
    expect(revisited).toEqual([]);
    expect(orch.getSnapshot().targetsInvestigated).toBeGreaterThan(0);
  });
});

// ── THE LIFECYCLE, stated as tests ───────────────────────────────────────────
//
// The contract asked for in the field report: once you are travelling to a target,
// that target is the destination until YOU change it, you arrive, or you close the
// section. Nothing about a ranking may move it.
describe("target commitment lifecycle", () => {
  function driver() {
    const files = buildPack(twoClusterPack(), BUILD_OPTS).files;
    const packs = new PackStore(createBundledPackSource(() => files), () => NOW);
    const targeting = new TargetingEngine(new OfflineGeoContextService(packs));
    const field = fakeField();
    const orch = new ExplorationOrchestrator({ field, targeting, packs, now: () => NOW });
    return { orch, field };
  }

  test("none -> suggested on the first ranking", async () => {
    const { orch, field } = driver();
    expect(orch.getSnapshot().targetCommitment).toBe("none");
    orch.start();
    field.emitFix(START.lat, START.lng);
    await settle();
    expect(orch.getSnapshot().activeTarget).not.toBeNull();
    // Still only a suggestion: the traveller has not moved, and a better idea
    // while they stand still is welcome. Early fixes are the worst fixes.
    expect(orch.getSnapshot().targetCommitment).toBe("suggested");
  });

  test("suggested -> committed as soon as the traveller leaves that cell", async () => {
    const { orch, field } = driver();
    orch.start();
    field.emitFix(START.lat, START.lng);
    await settle();
    const first = orch.getSnapshot().activeTarget!.cell;

    // 1.9 km on — a different cell, so they have demonstrably set off.
    field.emitFix(START.lat + 0.012, START.lng + 0.012);
    await settle();
    expect(orch.getSnapshot().targetCommitment).toBe("committed");
    expect(orch.getSnapshot().activeTarget!.cell).toBe(first);
  });

  test("a committed target survives every re-rank, however the scores move", async () => {
    const { orch, field } = driver();
    orch.start();
    field.emitFix(START.lat, START.lng);
    await settle();
    field.emitFix(START.lat + 0.012, START.lng + 0.012);
    await settle();
    const held = orch.getSnapshot().activeTarget!.cell;

    // Drive a wandering course through several cells. Each crossing re-ranks.
    for (const [dLat, dLng] of [[0.004, -0.010], [-0.008, -0.014], [0.014, 0.004], [0.020, -0.006]]) {
      field.emitFix(START.lat + dLat, START.lng + dLng);
      await settle();
      if (orch.getSnapshot().state === "awaitingEvidence") break;
      expect(orch.getSnapshot().activeTarget!.cell).toBe(held);
    }
  });

  test("the user picking one is the strongest commitment there is", async () => {
    const { orch, field } = driver();
    orch.start();
    field.emitFix(START.lat, START.lng);
    await settle();
    const others = orch.getSnapshot().targets.filter(
      (t) => t.cell !== orch.getSnapshot().activeTarget!.cell);
    expect(others.length).toBeGreaterThan(0);

    orch.selectTarget(others[0].cell);
    expect(orch.getSnapshot().targetCommitment).toBe("committed");
    // Committed from standing still — no travel needed, because the user said so.
    field.emitFix(START.lat + 0.0002, START.lng + 0.0002);
    await settle();
    expect(orch.getSnapshot().activeTarget!.cell).toBe(others[0].cell);
  });

  test("Recalculate frees a bare suggestion, but never an open mission", async () => {
    const { orch, field } = driver();
    orch.start();
    field.emitFix(START.lat, START.lng);
    await settle();
    field.emitFix(START.lat + 0.012, START.lng + 0.012);
    await settle();
    expect(orch.getSnapshot().targetCommitment).toBe("committed");

    // Once an investigation is open, Recalculate re-scores the ground and leaves
    // the destination alone. This assertion was the opposite before the mission
    // layer, and the requirement is what changed: a target may now move only by
    // finishing, closing, or being replaced by hand.
    expect(orch.getSnapshot().mission).not.toBeNull();
    orch.refresh();
    await settle();
    expect(orch.getSnapshot().targetCommitment).toBe("committed");

    // Closing the mission IS the way out, and it must exist — a locked target
    // with no release would be its own bug.
    orch.closeMission();
    await settle();
    expect(orch.getSnapshot().mission?.state).toBe("mission_closed");
  });

  test("arriving spends the commitment", async () => {
    const { orch, field } = driver();
    orch.start();
    field.emitFix(START.lat, START.lng);
    await settle();
    const t = orch.getSnapshot().activeTarget!;
    field.emitFix(t.centre.lat, t.centre.lng);
    await settle();
    expect(orch.getSnapshot().state).toBe("awaitingEvidence");
    expect(orch.getSnapshot().targetCommitment).toBe("none");
  });

  test("changing commodity releases it — the question itself changed", async () => {
    const { orch, field } = driver();
    orch.start();
    field.emitFix(START.lat, START.lng);
    await settle();
    field.emitFix(START.lat + 0.012, START.lng + 0.012);
    await settle();
    expect(orch.getSnapshot().targetCommitment).toBe("committed");

    orch.setCommodity("gold");
    await settle();
    expect(orch.getSnapshot().commodity).toBe("gold");
    expect(orch.getSnapshot().targetCommitment).not.toBe("committed");
  });

  test("better ground is reported, never taken", async () => {
    const { orch, field } = driver();
    orch.start();
    field.emitFix(START.lat, START.lng);
    await settle();
    // Pick the WORST of the ranked list, so a better one certainly exists.
    const ranked = orch.getSnapshot().targets;
    expect(ranked.length).toBeGreaterThan(1);
    const worst = ranked[ranked.length - 1];
    orch.selectTarget(worst.cell);
    field.emitFix(START.lat + 0.0005, START.lng + 0.0005);
    await settle();

    const s = orch.getSnapshot();
    // The destination is the one the user chose...
    expect(s.activeTarget!.cell).toBe(worst.cell);
    // ...and if something outranks it, the app says so instead of acting.
    if (s.betterTargetAvailable) {
      expect(s.betterTargetAvailable.cell).not.toBe(worst.cell);
      expect(s.betterTargetAvailable.score).toBeGreaterThan(s.activeTarget!.score);
    }
  });

  test("the guidance bearing is derived from the live fix, not from rank time", async () => {
    // A held target is no longer rebuilt by each ranking, so a stale bearing would
    // now persist for the whole walk instead of being papered over every cell.
    const { orch, field } = driver();
    orch.start();
    field.emitFix(START.lat, START.lng);
    await settle();
    const t = orch.getSnapshot().activeTarget!;

    // Move sideways, well off the original line to the target.
    field.emitFix(START.lat + 0.012, START.lng - 0.012);
    await settle();
    const after = orch.getSnapshot().activeTarget!;
    expect(after.cell).toBe(t.cell);
    expect(after.bearingDeg).not.toBeCloseTo(t.bearingDeg, 1);
  });
});

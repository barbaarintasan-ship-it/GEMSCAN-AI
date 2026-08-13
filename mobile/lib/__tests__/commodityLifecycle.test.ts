// The commodity lifecycle: what must stay in step when the selection changes.
//
// Three defects the audit measured, each with the consequence it had:
//
//   mission.commodity went stale     the evidence package, and therefore the AI,
//                                    assessed the wrong commodity
//   hotspotFor was never cleared     the hotspot stayed the one found for the old
//                                    commodity and could never be replaced
//   the target carried no provenance a universal target could be presented as a
//                                    commodity-specific recommendation
//
// Scoring is untouched by all of this. These are the connections between the
// selection and the workflow, which is where the audit found the breakage.
import type { FieldFix, SessionSnapshot } from "../field/types";
import { buildPack } from "../../../shared/geo-core/pack/build.ts";
import type { PackData } from "../../../shared/geo-core/pack/types.ts";
import { PackStore, createBundledPackSource } from "../geo/packStore.ts";
import { OfflineGeoContextService } from "../geo/offlineGeoContext.ts";
import { TargetingEngine } from "../geo/targeting.ts";
import { cellCentre } from "../geo/h3.ts";
import { ExplorationOrchestrator, type FieldSessionPort } from "../exploration/orchestrator.ts";
import { PackageStore } from "../exploration/packageStore";
import { Outbox, type KeyValueAdapter } from "../sync/outbox";
import type { MissionHotspot } from "../exploration/mission";

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
  for (const [tag, c] of [
    ["a", { lat: START.lat + 0.021, lng: START.lng + 0.021 }],
    ["b", { lat: START.lat - 0.002, lng: START.lng + 0.030 }],
  ] as const) {
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
      const fix: FieldFix = {
        lat, lng, accuracy: 8, altitude: 700, speed: 4, timestamp: NOW, provisional: false,
      };
      snap = { ...snap, lastFix: fix, fixCount: snap.fixCount + 1 };
      listeners.forEach((l) => l());
    },
  };
  return port;
}

function memoryStorage(): KeyValueAdapter {
  const data = new Map<string, string>();
  return { getItem: async (k) => data.get(k) ?? null, setItem: async (k, v) => { data.set(k, v); } };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));
jest.setTimeout(180_000);

/**
 * A harness whose hotspot stub NAMES ITS OWN AUTHOR.
 *
 * The returned cell id carries the commodity it was computed for, so a stale
 * hotspot is visible in an assertion rather than something to be inferred from
 * call counts.
 */
function harness(opts: { hotspot?: boolean } = {}) {
  const seen: Array<string | null> = [];
  const storage = memoryStorage();
  const files = buildPack(pack(), BUILD_OPTS).files;
  const packs = new PackStore(createBundledPackSource(() => files), () => NOW);
  const field = fakeField();
  const packages = new PackageStore({ storage, now: () => NOW });
  const outbox = new Outbox({ storage, now: () => NOW });
  const orch = new ExplorationOrchestrator({
    field, targeting: new TargetingEngine(new OfflineGeoContextService(packs)),
    packs, now: () => NOW, packages, outbox,
    findHotspot: async (cell, commodity): Promise<MissionHotspot | null> => {
      seen.push(commodity);
      if (!opts.hotspot) return null;
      const c = cellCentre(cell);
      return {
        lat: c.lat + 0.004, lng: c.lng + 0.004,
        cell: `${cell}-${commodity ?? "universal"}`,
        score: 0.7, liftOverCentre: 0.2,
      };
    },
  });
  return { orch, field, packages, seen };
}

/** Take a target and set off, so the mission is live and the target committed. */
async function travelling(h: ReturnType<typeof harness>) {
  h.orch.start();
  h.field.emitFix(START.lat, START.lng);
  await settle();
  const t = h.orch.getSnapshot().activeTarget!;
  h.orch.selectTarget(t.cell);
  await settle();
  h.field.emitFix(START.lat + 0.012, START.lng + 0.012);
  await settle();
  return t;
}

/** Drive into the target's cell, so the mission is on site. */
async function arrive(h: ReturnType<typeof harness>) {
  const cell = h.orch.getSnapshot().activeTarget!.cell;
  const c = cellCentre(cell);
  h.field.emitFix(c.lat, c.lng);
  await settle();
  await settle();
}

describe("1. mission.commodity follows the selection", () => {
  test("they are ALWAYS equal, through every change", async () => {
    const h = harness();
    await travelling(h);
    expect(h.orch.getSnapshot().mission!.commodity).toBe(h.orch.getSnapshot().commodity);

    for (const c of ["gold", "diamond", null, "iron"] as Array<string | null>) {
      h.orch.setCommodity(c);
      await settle();
      const s = h.orch.getSnapshot();
      expect(s.commodity).toBe(c);
      // Measured before the fix: mission.commodity stayed null while the snapshot
      // said gold.
      expect(s.mission!.commodity).toBe(c);
    }
  });

  test("the evidence package carries the commodity used for ranking", async () => {
    // The consequence that made this worth fixing. buildEvidencePackage reads
    // mission.commodity, and analyzeExplorationPackage reads the package — so a
    // stale value sent the AI to assess a commodity nobody selected.
    const h = harness();
    await travelling(h);
    h.orch.setCommodity("gold");
    await settle();
    await arrive(h);
    h.orch.beginInvestigation();
    const pkg = await h.orch.finishSection({ waypoints: [] });

    expect(pkg!.commodity).toBe("gold");
    expect(pkg!.commodity).toBe(h.orch.getSnapshot().commodity);
  });

  test("a CLOSED mission is not retro-labelled", async () => {
    // Only a live mission follows the selection. Rewriting a finished mission's
    // commodity would falsify the record of what was actually assessed.
    const h = harness();
    await travelling(h);
    h.orch.setCommodity("gold");
    await settle();
    h.orch.closeMission();
    await settle();
    expect(h.orch.getSnapshot().mission!.commodity).toBe("gold");

    h.orch.setCommodity("diamond");
    await settle();
    expect(h.orch.getSnapshot().commodity).toBe("diamond");
    expect(h.orch.getSnapshot().mission!.commodity).toBe("gold");
  });

  test("selecting the same commodity twice does nothing at all", async () => {
    const h = harness();
    await travelling(h);
    h.orch.setCommodity("gold");
    await settle();
    const before = h.orch.getSnapshot();
    h.orch.setCommodity("gold");
    await settle();
    // Same object identity: the early return means no patch, no re-rank, no churn.
    expect(h.orch.getSnapshot().mission).toBe(before.mission);
  });
});

describe("2. a commodity change invalidates the hotspot", () => {
  test("the hotspot is recalculated FOR THE NEW COMMODITY", async () => {
    const h = harness({ hotspot: true });
    await travelling(h);
    await arrive(h);
    expect(h.orch.getSnapshot().mission!.hotspot!.cell).toContain("universal");
    expect(h.seen).toEqual([null]);

    h.orch.setCommodity("gold");
    await settle();
    await settle();
    // Measured before the fix: hotspotFor still held the cell, so no second search
    // ran and the universal hotspot survived for ever.
    expect(h.seen).toEqual([null, "gold"]);
    expect(h.orch.getSnapshot().mission!.hotspot!.cell).toContain("gold");

    h.orch.setCommodity("diamond");
    await settle();
    await settle();
    expect(h.seen).toEqual([null, "gold", "diamond"]);
    expect(h.orch.getSnapshot().mission!.hotspot!.cell).toContain("diamond");
  });

  test("a commodity with no hotspot clears the old one rather than keeping it", async () => {
    // Going from "there is a hotspot" to "there is not" is a real answer, and the
    // old point must not linger as though it still applied.
    let withHotspot = true;
    const files = buildPack(pack(), BUILD_OPTS).files;
    const packs = new PackStore(createBundledPackSource(() => files), () => NOW);
    const field = fakeField();
    const orch = new ExplorationOrchestrator({
      field, targeting: new TargetingEngine(new OfflineGeoContextService(packs)),
      packs, now: () => NOW,
      findHotspot: async (cell) => {
        if (!withHotspot) return null;
        const c = cellCentre(cell);
        return { lat: c.lat + 0.004, lng: c.lng + 0.004, cell: `${cell}-x`, score: 0.7, liftOverCentre: 0.2 };
      },
    });
    orch.start();
    field.emitFix(START.lat, START.lng);
    await settle();
    orch.selectTarget(orch.getSnapshot().activeTarget!.cell);
    await settle();
    const c = cellCentre(orch.getSnapshot().activeTarget!.cell);
    field.emitFix(c.lat, c.lng);
    await settle();
    await settle();
    expect(orch.getSnapshot().mission!.hotspot).not.toBeNull();

    withHotspot = false;
    orch.setCommodity("chromium");
    await settle();
    await settle();
    expect(orch.getSnapshot().mission!.hotspot).toBeNull();
  });

  test("no search runs before the geologist has arrived", async () => {
    // The search costs 49 scored points. It belongs on arrival, not on every
    // commodity tap while still walking.
    const h = harness({ hotspot: true });
    await travelling(h);
    h.orch.setCommodity("gold");
    await settle();
    await settle();
    expect(h.seen).toEqual([]);
  });
});

describe("3. a target records what it was ranked under", () => {
  test("scoredForCommodity is the commodity used, on every ranked target", async () => {
    const h = harness();
    h.orch.start();
    h.field.emitFix(START.lat, START.lng);
    await settle();
    expect(h.orch.getSnapshot().activeTarget!.scoredForCommodity).toBeNull();
    expect(h.orch.getSnapshot().targets.every((x) => x.scoredForCommodity === null)).toBe(true);

    h.orch.setCommodity("gold");
    await settle();
    expect(h.orch.getSnapshot().activeTarget!.scoredForCommodity).toBe("gold");
    // The alternatives carry it too — a geologist picking one from the list gets the
    // same guarantee as the one that was offered.
    expect(h.orch.getSnapshot().targets.every((x) => x.scoredForCommodity === "gold")).toBe(true);
  });

  test("the provenance never lags the selection after a re-rank", async () => {
    // The misleading case from the audit: committed under UNIVERSAL, then GOLD is
    // picked. Whatever cell the re-rank hands back, the field describes what
    // produced it — so the screen can never imply a gold-specific target that was
    // not ranked for gold.
    const h = harness();
    await travelling(h);
    expect(h.orch.getSnapshot().activeTarget!.scoredForCommodity).toBeNull();

    h.orch.setCommodity("gold");
    await settle();
    const s = h.orch.getSnapshot();
    expect(s.activeTarget!.scoredForCommodity).toBe("gold");
    expect(s.activeTarget!.scoredForCommodity).toBe(s.commodity);
  });

  test("a target selected by hand keeps its own provenance", async () => {
    const h = harness();
    h.orch.start();
    h.field.emitFix(START.lat, START.lng);
    await settle();
    h.orch.setCommodity("gold");
    await settle();
    const others = h.orch.getSnapshot().targets.filter(
      (x) => x.cell !== h.orch.getSnapshot().activeTarget!.cell);
    if (others.length === 0) return;
    h.orch.selectTarget(others[0].cell);
    await settle();
    expect(h.orch.getSnapshot().activeTarget!.scoredForCommodity).toBe("gold");
  });
});

describe("4. none of this touched the target lock", () => {
  test("a committed target still survives every GPS update", async () => {
    const h = harness();
    const t = await travelling(h);
    expect(h.orch.getSnapshot().targetCommitment).toBe("committed");

    for (const [dLat, dLng] of [[0.004, -0.010], [-0.012, -0.008], [0.018, 0.006]]) {
      h.field.emitFix(START.lat + dLat, START.lng + dLng);
      await settle();
      if (h.orch.getSnapshot().state === "awaitingEvidence") break;
      expect(h.orch.getSnapshot().activeTarget!.cell).toBe(t.cell);
    }
  });

  test("a commodity change still releases the lock — the question changed", async () => {
    // Documented policy, unchanged: the commodity IS the question, so a new
    // question earns a new answer. What changed is only that the mission, the
    // hotspot and the provenance now keep up with it.
    const h = harness();
    await travelling(h);
    expect(h.orch.getSnapshot().targetCommitment).toBe("committed");
    h.orch.setCommodity("gold");
    await settle();
    expect(h.orch.getSnapshot().targetCommitment).not.toBe("committed");
    // And the mission is still live — releasing the lock is not abandoning the walk.
    expect(h.orch.getSnapshot().mission!.state).toBe("navigating");
  });
});

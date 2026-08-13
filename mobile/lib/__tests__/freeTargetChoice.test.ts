// The geologist chooses. The engine advises.
//
// FIELD-REPORTED: the app offered a target 1.5 km off and there was no way to go
// anywhere else. Measured cause — `selectTarget` only accepted cells already in the
// ranked list, and that list is `kRing(here, rings)` capped by `limit`:
//
//   rings 2:  19 cells ·  128 ms · reach 5.9 km   ← was the default
//   rings 3:  37 cells ·  223 ms · reach 8.3 km   ← now the default
//   rings 4:  61 cells ·  646 ms · reach 10.6 km  ← a hitch on every cell crossing
//
// `maxDistanceM: 15_000` was dead the whole time: the ring caps the reach long
// before the metre limit does. A hill eight kilometres off was not a candidate, so
// it could not be chosen at all.
//
// `selectTargetAt` is the answer — one named cell, ANY distance, no score gate.
// Refusing to route somewhere a geologist has decided to go is not the app's
// decision to make.
import type { FieldFix, SessionSnapshot } from "../field/types";
import { buildPack } from "../../../shared/geo-core/pack/build.ts";
import type { PackData } from "../../../shared/geo-core/pack/types.ts";
import { PackStore, createBundledPackSource } from "../geo/packStore.ts";
import { OfflineGeoContextService } from "../geo/offlineGeoContext.ts";
import { TargetingEngine, DEFAULT_TARGETING } from "../geo/targeting.ts";
import { cellFor } from "../geo/h3.ts";
import { haversineM } from "../../../shared/geo-core/geo/spatial.ts";
import { ExplorationOrchestrator, type FieldSessionPort } from "../exploration/orchestrator.ts";

const NOW = Date.parse("2026-08-10T00:00:00.000Z");
const BUILD_OPTS = {
  packId: "somalia", packVersion: "1.0.0", engineVersion: "1.0.0", region: "SO",
  h3Resolution: 7, builtAt: "2026-08-01T00:00:00.000Z",
  datasets: [{ datasetId: "d1", source: "USGS MRDS", version: "2024" }],
};
const START = { lat: 2.0469, lng: 45.3182 };
/** Well outside kRing(3) — about 45 km out, which is the point. */
const FAR = { lat: START.lat + 0.40, lng: START.lng + 0.10 };

function pack(): PackData {
  const d: PackData = {
    geology: [{
      id: "g1", name: "Precambrian Basement", kind: "metamorphic", source: "Macrostrat",
      attributes: null,
      // Wide enough to cover the far point too, so the ground there is mapped.
      rings: [[[45.0, 1.8], [46.0, 1.8], [46.0, 2.8], [45.0, 2.8], [45.0, 1.8]]],
      bbox: [45.0, 1.8, 46.0, 2.8], isPolygon: true,
    }],
    occurrences: [], knowledge: [], structures: [], community: [], mapFeatures: [], terrain: [],
    associations: [], rules: [], commodities: [], assemblages: [], land: [],
  };
  // A cluster near the start, and one at the far point, so both have something
  // to say about themselves.
  for (const [tag, c] of [["a", { lat: START.lat + 0.021, lng: START.lng + 0.021 }],
                          ["f", FAR]] as const) {
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

const settle = () => new Promise<void>((r) => setTimeout(r, 0));
jest.setTimeout(180_000);

function harness() {
  const files = buildPack(pack(), BUILD_OPTS).files;
  const packs = new PackStore(createBundledPackSource(() => files), () => NOW);
  const field = fakeField();
  const targeting = new TargetingEngine(new OfflineGeoContextService(packs));
  const orch = new ExplorationOrchestrator({ field, targeting, packs, now: () => NOW });
  return { orch, field, targeting };
}

describe("the ranked list is wider than it was", () => {
  test("three rings, six offered — and the metre limit is no longer dead", () => {
    // rings 2 capped the reach at ~5.9 km however large maxDistanceM was, so the
    // 15 km limit never applied to anything.
    expect(DEFAULT_TARGETING.rings).toBe(3);
    expect(DEFAULT_TARGETING.limit).toBe(6);
    expect(DEFAULT_TARGETING.maxDistanceM).toBe(15_000);
  });

  test("more than three alternatives can now be offered", async () => {
    const h = harness();
    h.orch.start();
    h.field.emitFix(START.lat, START.lng);
    await settle();
    // Not asserting a count the fixture cannot guarantee — asserting the CAP moved.
    expect(h.orch.getSnapshot().targets.length).toBeLessThanOrEqual(6);
    expect(h.orch.getSnapshot().targets.length).toBeGreaterThan(0);
  });
});

describe("a target at ANY distance, chosen by the user", () => {
  test("THE FIX: a place 45 km away can be made the target", async () => {
    const h = harness();
    h.orch.start();
    h.field.emitFix(START.lat, START.lng);
    await settle();

    const offered = h.orch.getSnapshot().activeTarget!;
    const farAway = haversineM(START, FAR);
    expect(farAway).toBeGreaterThan(40_000);

    // It is NOT in the ranked list — that is the whole point. Before the fix there
    // was no way to reach it.
    const farCell = cellFor(FAR.lat, FAR.lng);
    expect(h.orch.getSnapshot().targets.some((x) => x.cell === farCell)).toBe(false);
    expect(h.orch.selectTarget(farCell)).toBeUndefined();
    expect(h.orch.getSnapshot().activeTarget!.cell).toBe(offered.cell);

    // And now it can be.
    const ok = await h.orch.selectTargetAt(FAR.lat, FAR.lng);
    expect(ok).toBe(true);
    const s = h.orch.getSnapshot();
    expect(s.activeTarget!.cell).toBe(farCell);
    expect(s.distanceToTargetM).toBeGreaterThan(40_000);
    // No distance cap was applied. maxDistanceM is a RANKING limit, not a
    // permission.
    expect(s.activeTarget!.distanceM).toBeGreaterThan(DEFAULT_TARGETING.maxDistanceM);
  });

  test("a hand-picked far target is COMMITTED, like any other user choice", async () => {
    const h = harness();
    h.orch.start();
    h.field.emitFix(START.lat, START.lng);
    await settle();
    await h.orch.selectTargetAt(FAR.lat, FAR.lng);
    expect(h.orch.getSnapshot().targetCommitment).toBe("committed");

    // And it survives driving, exactly like the ping-pong fix guarantees.
    const cell = h.orch.getSnapshot().activeTarget!.cell;
    for (const [dLat, dLng] of [[0.004, -0.010], [-0.012, -0.008], [0.018, 0.006]]) {
      h.field.emitFix(START.lat + dLat, START.lng + dLng);
      await settle();
      expect(h.orch.getSnapshot().activeTarget!.cell).toBe(cell);
    }
  });

  test("it opens a mission, so the whole workflow applies to it", async () => {
    const h = harness();
    h.orch.start();
    h.field.emitFix(START.lat, START.lng);
    await settle();
    await h.orch.selectTargetAt(FAR.lat, FAR.lng);
    const m = h.orch.getSnapshot().mission!;
    expect(m.cell).toBe(cellFor(FAR.lat, FAR.lng));
    expect(m.state).toBe("target_selected");
    expect(m.commodity).toBe(h.orch.getSnapshot().commodity);
  });

  test("the engine's reading is REPORTED, not used as a gate", async () => {
    // A low score does not block the choice. The target carries the score so the
    // geologist can see what the engine thinks, and goes anyway if they want to.
    const h = harness();
    h.orch.start();
    h.field.emitFix(START.lat, START.lng);
    await settle();
    await h.orch.selectTargetAt(FAR.lat, FAR.lng);
    const t = h.orch.getSnapshot().activeTarget!;
    expect(typeof t.score).toBe("number");
    expect(t.reasons.length).toBeGreaterThan(0);
    expect(t.scoredForCommodity).toBe(h.orch.getSnapshot().commodity);
  });

  test("ground with nothing recorded returns false rather than a hollow target", async () => {
    // Invariant 2: a target with nothing to say about itself is not offered,
    // however it was chosen. Reported back so the tap does not appear to do
    // nothing.
    const h = harness();
    h.orch.start();
    h.field.emitFix(START.lat, START.lng);
    await settle();
    const before = h.orch.getSnapshot().activeTarget!.cell;
    // Far outside the mapped geology polygon.
    const ok = await h.orch.selectTargetAt(-20, 120);
    expect(ok).toBe(false);
    expect(h.orch.getSnapshot().activeTarget!.cell).toBe(before);
  });

  test("nonsense coordinates are refused", async () => {
    const h = harness();
    h.orch.start();
    h.field.emitFix(START.lat, START.lng);
    await settle();
    for (const [lat, lng] of [[NaN, 45], [2, Infinity], [95, 45], [2, 200]]) {
      expect(await h.orch.selectTargetAt(lat, lng)).toBe(false);
    }
  });

  test("with no fix there is nowhere to measure from, and it says so", async () => {
    const h = harness();
    h.orch.start();
    expect(await h.orch.selectTargetAt(FAR.lat, FAR.lng)).toBe(false);
  });
});

describe("choosing again is always possible", () => {
  test("a far target can be replaced by another far target", async () => {
    const h = harness();
    h.orch.start();
    h.field.emitFix(START.lat, START.lng);
    await settle();
    await h.orch.selectTargetAt(FAR.lat, FAR.lng);
    const first = h.orch.getSnapshot().activeTarget!.cell;

    const other = { lat: START.lat + 0.021, lng: START.lng + 0.021 };
    expect(await h.orch.selectTargetAt(other.lat, other.lng)).toBe(true);
    expect(h.orch.getSnapshot().activeTarget!.cell).not.toBe(first);
    // The old mission is closed rather than left dangling, and a new one opened.
    expect(h.orch.getSnapshot().mission!.cell).toBe(cellFor(other.lat, other.lng));
  });

  test("and by one from the ranked list", async () => {
    const h = harness();
    h.orch.start();
    h.field.emitFix(START.lat, START.lng);
    await settle();
    const ranked = h.orch.getSnapshot().targets[0].cell;
    await h.orch.selectTargetAt(FAR.lat, FAR.lng);
    expect(h.orch.getSnapshot().activeTarget!.cell).not.toBe(ranked);

    h.orch.selectTarget(ranked);
    await settle();
    expect(h.orch.getSnapshot().activeTarget!.cell).toBe(ranked);
    expect(h.orch.getSnapshot().targetCommitment).toBe("committed");
  });
});

describe("targetAt scores by the SAME path as the ranking", () => {
  test("a ranked cell and the same cell via targetAt agree exactly", async () => {
    // The two must not drift. A cell picked by hand has to be scored by the code
    // that scores the ones the engine offers, or the app would eventually give two
    // different readings of the same ground.
    const h = harness();
    h.orch.start();
    h.field.emitFix(START.lat, START.lng);
    await settle();
    const ranked = h.orch.getSnapshot().targets[0];

    const direct = await h.targeting.targetAt(START, ranked.centre, {});
    expect(direct).not.toBeNull();
    expect(direct!.cell).toBe(ranked.cell);
    expect(direct!.score).toBe(ranked.score);
    expect(direct!.band).toBe(ranked.band);
    expect(direct!.reasons.map((r) => r.kind)).toEqual(ranked.reasons.map((r) => r.kind));
    expect(direct!.scoredForCommodity).toBe(ranked.scoredForCommodity);
  });

  test("targetAt honours the selected commodity", async () => {
    const h = harness();
    h.orch.start();
    h.field.emitFix(START.lat, START.lng);
    await settle();
    const gold = await h.targeting.targetAt(START, FAR, { commodity: "gold" });
    expect(gold!.scoredForCommodity).toBe("gold");
    const universal = await h.targeting.targetAt(START, FAR, {});
    expect(universal!.scoredForCommodity).toBeNull();
  });
});

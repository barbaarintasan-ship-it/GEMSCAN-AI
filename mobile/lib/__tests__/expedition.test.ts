// Distance classifies a target; it never removes one.
//
// The behaviour under test is the fix for a real dead end: standing near
// Bosaso, the app said "nothing to walk to" while the pack held a gold
// occurrence 94 km south-west. Explorers have vehicles.
import {
  classifyDistance, regionalTargets, BAND_LIMITS_M, WALK_KMH, VEHICLE_KMH,
} from "../geo/expedition";
import type { PackData } from "../../../shared/geo-core/pack/types.ts";

const HERE = { lat: 9.5, lng: 49.0 };

describe("classifyDistance", () => {
  test("0–500 m is immediate, and you walk", () => {
    expect(classifyDistance(120).band).toBe("immediate");
    expect(classifyDistance(500).band).toBe("immediate");
    expect(classifyDistance(500).transport).toBe("walk");
  });

  test("500 m–5 km is local: walk or drive", () => {
    expect(classifyDistance(501).band).toBe("local");
    expect(classifyDistance(5_000).band).toBe("local");
    expect(classifyDistance(3_000).transport).toBe("walk_or_drive");
  });

  test("5–50 km is regional, and a vehicle is recommended", () => {
    expect(classifyDistance(5_001).band).toBe("regional");
    expect(classifyDistance(50_000).band).toBe("regional");
    expect(classifyDistance(20_000).transport).toBe("vehicle");
  });

  test("beyond 50 km is an expedition — still a target, not a refusal", () => {
    const c = classifyDistance(94_000);
    expect(c.band).toBe("expedition");
    expect(c.transport).toBe("expedition");
    expect(c.travelMinutes).toBeGreaterThan(0);
  });

  test("the band boundaries are exactly where they claim to be", () => {
    expect(classifyDistance(BAND_LIMITS_M.immediate).band).toBe("immediate");
    expect(classifyDistance(BAND_LIMITS_M.immediate + 1).band).toBe("local");
    expect(classifyDistance(BAND_LIMITS_M.local).band).toBe("local");
    expect(classifyDistance(BAND_LIMITS_M.local + 1).band).toBe("regional");
    expect(classifyDistance(BAND_LIMITS_M.regional).band).toBe("regional");
    expect(classifyDistance(BAND_LIMITS_M.regional + 1).band).toBe("expedition");
  });

  test("ON FOOT the straight line stands — a road is irrelevant over 4 km of ground", () => {
    // 4 km on foot at 4 km/h is an hour, and no road factor applies: you walk
    // over the ground. This is the half of the model that must NOT change.
    const c = classifyDistance(4_000);
    expect(c.travelMinutes).toBe(60);
    expect(c.roadFactorApplied).toBe(1);
    expect(c.travelDistanceM).toBe(4_000);
  });

  test("ONCE DRIVING the road is the journey, not the straight line", () => {
    // 35 km of straight line is 70 km of road at the default factor: 1 h 45 at
    // the measured 40 km/h, not the one hour the old test asserted. That hour is
    // how a geologist came to plan a night drive on half the real time.
    const c = classifyDistance(35_000, 2);
    expect(c.roadFactorApplied).toBe(2);
    expect(c.travelDistanceM).toBe(70_000);
    expect(c.travelMinutes).toBe(105);
  });

  test("the Karkaar case, as measured", () => {
    // 94.4 km straight, factor 2.02 from the geologist's own odometer.
    const c = classifyDistance(94_400, 2.02);
    expect(Math.round(c.travelDistanceM / 1000)).toBe(191);
    // The screen said 2 h 42 (162 min). The measured answer is 4 h 45.
    expect(c.travelMinutes).toBe(286);
  });

  test("a nonsense factor cannot become a nonsense plan", () => {
    // A road is never shorter than the straight line.
    expect(classifyDistance(60_000, 0.2).roadFactorApplied).toBe(1);
    expect(classifyDistance(60_000, 99).roadFactorApplied).toBeLessThanOrEqual(4);
    expect(classifyDistance(60_000, Number.NaN).roadFactorApplied).toBe(1);
  });

  test("the estimates are pessimistic on purpose", () => {
    // A flattering estimate is worse than none: someone plans a return trip on
    // it. These speeds must stay slow enough to be survivable.
    expect(WALK_KMH).toBeLessThanOrEqual(5);
    expect(VEHICLE_KMH).toBeLessThanOrEqual(50);
  });

  test("nonsense distance does not produce a nonsense journey", () => {
    expect(classifyDistance(NaN).travelMinutes).toBeNull();
    expect(classifyDistance(-5).travelMinutes).toBeNull();
  });
});

function pack(): PackData {
  return {
    geology: [],
    occurrences: [
      // ~94 km south — the real one the app used to hide.
      { id: "far-gold", name: "Far Gold", commodity_key: "gold", deposit_type: null, host_rocks: null,
        lat: HERE.lat - 0.85, lng: HERE.lng, dataset_id: "d", source: "MRDS", version: null, reference: null, cell: "c" },
      // ~2 km north, unnamed commodity.
      { id: "near-unknown", name: null, commodity_key: null, deposit_type: null, host_rocks: null,
        lat: HERE.lat + 0.018, lng: HERE.lng, dataset_id: "d", source: "MRDS", version: null, reference: null, cell: "c" },
    ],
    knowledge: [], structures: [], community: [],
    mapFeatures: [{
      id: "f1", kind: "fault", name: "Nogal Fault", source: "macrostrat_lines", attributes: null,
      lines: [[[HERE.lng + 0.5, HERE.lat - 0.2], [HERE.lng + 0.5, HERE.lat + 0.2]]],
      bbox: [HERE.lng + 0.5, HERE.lat - 0.2, HERE.lng + 0.5, HERE.lat + 0.2],
    }],
    terrain: [], associations: [], rules: [], commodities: [], assemblages: [], land: [],
  };
}

describe("regionalTargets", () => {
  const targets = regionalTargets(pack(), HERE);

  test("a 94 km occurrence is LISTED, not filtered out", () => {
    const far = targets.find((t) => t.id === "occ:far-gold");
    expect(far).toBeDefined();
    expect(far!.distanceM).toBeGreaterThan(90_000);
    expect(far!.distanceClass.band).toBe("expedition");
  });

  test("every target carries a bearing, a compass point and a journey", () => {
    for (const t of targets) {
      expect(t.compass).toMatch(/^[NSEW]/);
      expect(t.bearingDeg).toBeGreaterThanOrEqual(0);
      expect(t.bearingDeg).toBeLessThan(360);
      expect(t.distanceClass.travelMinutes).toBeGreaterThan(0);
    }
  });

  test("mapped faults are included as targets in their own right", () => {
    expect(targets.some((t) => t.kind === "fault")).toBe(true);
  });

  test("a near unnamed pin outranks a far gold occurrence", () => {
    const near = targets.find((t) => t.id === "occ:near-unknown")!;
    const far = targets.find((t) => t.id === "occ:far-gold")!;
    // Distance matters — but see the next test: it never zeroes anything.
    expect(near.priority).toBeGreaterThan(far.priority);
  });

  test("distance decays priority but never to zero", () => {
    const far = targets.find((t) => t.id === "occ:far-gold")!;
    expect(far.priority).toBeGreaterThan(0);
  });

  test("a named commodity outranks an unnamed pin at the same distance", () => {
    const d = pack();
    d.occurrences = [
      { ...d.occurrences[1], id: "named", commodity_key: "gold" },
      { ...d.occurrences[1], id: "unnamed", commodity_key: null },
    ];
    const t = regionalTargets(d, HERE);
    const named = t.find((x) => x.id === "occ:named")!;
    const unnamed = t.find((x) => x.id === "occ:unnamed")!;
    expect(named.priority).toBeGreaterThan(unnamed.priority);
  });

  test("minDistanceM hands the near ground back to the local engine", () => {
    const t = regionalTargets(pack(), HERE, { minDistanceM: 15_000 });
    expect(t.every((x) => x.distanceM >= 15_000)).toBe(true);
    // And the far one is still there — the floor removes near, not far.
    expect(t.some((x) => x.id === "occ:far-gold")).toBe(true);
  });

  test("the limit caps the LIST, never the range", () => {
    const d = pack();
    d.occurrences = Array.from({ length: 50 }, (_, i) => ({
      ...d.occurrences[0], id: `o${i}`, lat: HERE.lat - 0.5 - i * 0.01,
    }));
    const t = regionalTargets(d, HERE, { limit: 5 });
    expect(t).toHaveLength(5);
    // What survives is the highest priority, not the nearest handful by accident.
    expect(t[0].priority).toBeGreaterThanOrEqual(t[4].priority);
  });

  test("an empty pack yields an empty list, not a fabricated one", () => {
    const empty: PackData = {
      geology: [], occurrences: [], knowledge: [], structures: [], community: [],
      mapFeatures: [], terrain: [], associations: [], rules: [], commodities: [], assemblages: [], land: [],
    };
    expect(regionalTargets(empty, HERE)).toEqual([]);
  });
});

// ── The model against the journey that produced it ──────────────────────────
//
// A travel estimate is only worth what it predicts. This asserts the model
// against the Karkaar expedition of 07–08/08/2026, measured two independent ways:
//
//     straight line   64.49 km   PostGIS, from the recorded GPS fixes
//     road, one way  130.00 km   the geologist's odometer   -> factor 2.02
//     average speed   40 km/h    the geologist's own figure
//     elapsed          3 h 15
//
// Nothing here is tuned. The factor and the speed both came off that trip, and
// the test is whether the two together reproduce it.
describe("the Karkaar journey, reproduced", () => {
  const STRAIGHT_M = 64_490;
  const ODOMETER_KM = 130;
  const FACTOR = ODOMETER_KM / (STRAIGHT_M / 1000);   // 2.016

  test("the model predicts the road distance actually driven", () => {
    const c = classifyDistance(STRAIGHT_M, FACTOR);
    expect(Math.round(c.travelDistanceM / 1000)).toBe(ODOMETER_KM);
  });

  test("the model predicts the time actually taken", () => {
    const c = classifyDistance(STRAIGHT_M, FACTOR);
    // 130 km at 40 km/h is 3 h 15.
    expect(c.travelMinutes).toBe(195);
  });

  test("the target that was misreported now reads honestly", () => {
    // The screen said "94.4 km · 2 h 42 min" and a night drive was planned on it.
    const c = classifyDistance(94_400, FACTOR);
    expect(Math.round(c.travelDistanceM / 1000)).toBe(190);
    expect(c.travelMinutes).toBe(285);   // 4 h 45
    // Nearly two hours more than the figure that was shown.
    expect(c.travelMinutes).toBeGreaterThan(162 + 100);
  });

  test("the speed is the measured one, not the guess it replaced", () => {
    expect(VEHICLE_KMH).toBe(40);
  });
});

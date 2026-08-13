// How much further the road is than the straight line — measured, not assumed.
//
// The app told a geologist "94.4 km · 2 h 42 min". The distance was right; the
// time was computed from it at road speed, and you cannot drive a straight line.
// Their odometer settled it: 130 km of road for a 64.49 km straight line, at an
// average of 40 km/h. So the real journey to that target was about 190 km and
// nearly five hours.
//
// What is asserted here is mostly the REFUSALS. A multiplier that is sometimes
// wrong is worse than a documented default, because it carries the authority of a
// measurement — so the interesting cases are the ones this declines to learn from.
import {
  measureFrom, RoadFactorStore, DEFAULT_ROAD_FACTOR, MIN_ROAD_FACTOR,
  MAX_ROAD_FACTOR, MIN_MEASURABLE_DISPLACEMENT_M, KEEP_MEASUREMENTS,
  ROAD_FACTOR_STORAGE_KEY,
} from "../geo/roadFactor";
import type { KeyValueAdapter } from "../samples/localSampleStore";

function storage(initial?: string) {
  const map = new Map<string, string>();
  if (initial) map.set(ROAD_FACTOR_STORAGE_KEY, initial);
  const adapter: KeyValueAdapter = {
    getItem: async (k) => map.get(k) ?? null,
    setItem: async (k, v) => { map.set(k, v); },
  };
  return { adapter, map };
}

const NOW = 1_800_000_000_000;

describe("measuring the Karkaar journey", () => {
  test("an out-and-back drive gives the factor the odometer gave", () => {
    // 260 km driven, furthest point 64.49 km out, ended back at the start.
    // One way is half the odometer: 130 / 64.49 = 2.016.
    const m = measureFrom({
      trackDistanceM: 260_000,
      maxDisplacementM: 64_490,
      endDisplacementM: 300,
      at: NOW,
    })!;
    expect(m).not.toBeNull();
    expect(m.returned).toBe(true);
    expect(m.factor).toBeCloseTo(2.016, 2);
  });

  test("a one-way drive is not halved", () => {
    // Ended at the furthest point: the whole track IS the one-way road.
    const m = measureFrom({
      trackDistanceM: 130_000,
      maxDisplacementM: 64_490,
      endDisplacementM: 64_000,
      at: NOW,
    })!;
    expect(m.returned).toBe(false);
    expect(m.factor).toBeCloseTo(2.016, 2);
  });
});

describe("what it refuses to learn from", () => {
  test("walking around an outcrop teaches nothing about roads", () => {
    // 3 km of wandering inside 200 m is not a road factor of 15.
    expect(measureFrom({
      trackDistanceM: 3_000, maxDisplacementM: 200, endDisplacementM: 50, at: NOW,
    })).toBeNull();
  });

  test("anything under the measurable threshold is declined", () => {
    expect(measureFrom({
      trackDistanceM: 20_000,
      maxDisplacementM: MIN_MEASURABLE_DISPLACEMENT_M - 1,
      endDisplacementM: 100,
      at: NOW,
    })).toBeNull();
  });

  test("a wandering multi-leg day cannot be split into one road", () => {
    // Ended 30 km from the start having reached 80 km out: neither an
    // out-and-back nor a one-way, so `trackDistanceM` is not one journey.
    expect(measureFrom({
      trackDistanceM: 300_000, maxDisplacementM: 80_000, endDisplacementM: 30_000, at: NOW,
    })).toBeNull();
  });

  test("a road shorter than the straight line is impossible, so it is refused", () => {
    expect(measureFrom({
      trackDistanceM: 40_000, maxDisplacementM: 60_000, endDisplacementM: 60_000, at: NOW,
    })).toBeNull();
  });

  test("an absurd factor is refused rather than clamped into plausibility", () => {
    // 10x would be a helicopter or a bug. Clamping it to 4 would hide which.
    expect(measureFrom({
      trackDistanceM: 600_000, maxDisplacementM: 60_000, endDisplacementM: 60_000, at: NOW,
    })).toBeNull();
  });

  test("non-finite input is refused", () => {
    expect(measureFrom({
      trackDistanceM: Number.NaN, maxDisplacementM: 60_000, endDisplacementM: 60_000, at: NOW,
    })).toBeNull();
  });
});

describe("the factor in force", () => {
  const store = () => new RoadFactorStore({ storage: storage().adapter });

  test("with nothing measured it is the documented default", async () => {
    const s = store();
    await s.load();
    expect(s.current()).toBe(DEFAULT_ROAD_FACTOR);
    expect(s.isMeasured()).toBe(false);
  });

  test("one measurement replaces the default", async () => {
    const s = store();
    await s.record({ factor: 2.016, displacementM: 64_490, at: NOW, returned: true });
    expect(s.current()).toBeCloseTo(2.016, 3);
    expect(s.isMeasured()).toBe(true);
  });

  test("MEDIAN, so one strange day cannot move the plan", async () => {
    // A ferry, a closed road, a day driving in circles. The mean would follow it;
    // the median does not, and a geologist plans fuel on this number.
    const s = store();
    for (const f of [1.9, 2.0, 2.1, 3.9]) {
      await s.record({ factor: f, displacementM: 60_000, at: NOW, returned: true });
    }
    expect(s.current()).toBeCloseTo(2.05, 2);
  });

  test("it survives a restart, which is the only way it accumulates", async () => {
    const st = storage();
    const first = new RoadFactorStore({ storage: st.adapter });
    await first.record({ factor: 2.2, displacementM: 70_000, at: NOW, returned: false });

    const second = new RoadFactorStore({ storage: st.adapter });
    await second.load();
    expect(second.current()).toBeCloseTo(2.2, 3);
  });

  test("history is bounded — the ground changes, old trips stop mattering", async () => {
    const s = store();
    for (let i = 0; i < KEEP_MEASUREMENTS + 8; i++) {
      await s.record({ factor: 2, displacementM: 60_000, at: NOW + i, returned: true });
    }
    expect(s.count()).toBe(KEEP_MEASUREMENTS);
  });

  test("a corrupt history falls back to the default rather than throwing", async () => {
    const s = new RoadFactorStore({ storage: storage("{not json").adapter });
    await s.load();
    expect(s.current()).toBe(DEFAULT_ROAD_FACTOR);
  });

  test("stored values outside the possible range are dropped on load", async () => {
    const bad = JSON.stringify({
      version: 1,
      measurements: [
        { factor: 0.5, displacementM: 60_000, at: NOW, returned: true },   // impossible
        { factor: 99, displacementM: 60_000, at: NOW, returned: true },    // impossible
        { factor: 2.2, displacementM: 60_000, at: NOW, returned: true },   // kept
      ],
    });
    const s = new RoadFactorStore({ storage: storage(bad).adapter });
    await s.load();
    expect(s.count()).toBe(1);
    expect(s.current()).toBeCloseTo(2.2, 3);
  });

  test("the bounds are what physics and sanity allow", () => {
    expect(MIN_ROAD_FACTOR).toBe(1);
    expect(MAX_ROAD_FACTOR).toBeLessThanOrEqual(4);
    expect(DEFAULT_ROAD_FACTOR).toBeGreaterThanOrEqual(MIN_ROAD_FACTOR);
    expect(DEFAULT_ROAD_FACTOR).toBeLessThanOrEqual(MAX_ROAD_FACTOR);
  });
});

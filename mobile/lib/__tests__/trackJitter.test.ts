// Standing still is not walking.
//
// MEASURED: a phone lying on a desk, ±13 m fix, drew roughly sixty metres of
// traverse on the map and the sheet read "Movement: moving 4.1 km/h". Nothing had
// moved. The recorder's gate was
//
//   max(minDistanceM × 2^thin, accuracy × 0.5)  =  max(10, 6.5)  =  10 m
//
// so at any accuracy a field receiver actually achieves the accuracy term never
// won, and ±13 m noise clears ten metres several times a minute.
//
// This got worse for a good reason and had to be fixed properly rather than
// reverted: `WALKING_PROFILE.distanceIntervalM` is now 0, because Android applies
// the distance and time gates TOGETHER and a stationary geologist was receiving no
// fix at all. Every fix now reaches the recorder, so the recorder is the only
// thing standing between GPS wander and a drawn line.
//
// The gate is now `accuracy × 1.4`. Two fixes each uncertain by about `a` give a
// displacement uncertain by about `a·√2`, so this asks that the movement be larger
// than the error in measuring it — which is the actual question.
import { TrackRecorder, DEFAULT_TRACK_CONFIG } from "../field/trackRecorder";
import type { FieldFix } from "../field/types";

const START = { lat: 9.5149, lng: 49.0904 };
const T0 = Date.parse("2026-08-13T06:00:00.000Z");

/** Metres → degrees, near the equator. Good enough at these distances. */
const M_LAT = 1 / 110_574;
const M_LNG = 1 / (111_320 * Math.cos((START.lat * Math.PI) / 180));

function fix(northM: number, eastM: number, at: number, accuracy = 13): FieldFix {
  return {
    lat: START.lat + northM * M_LAT,
    lng: START.lng + eastM * M_LNG,
    accuracy, altitude: 700, speed: null, timestamp: at, provisional: false,
  };
}

function recorder() {
  const r = new TrackRecorder({}, () => T0);
  r.begin("fs-jitter", T0);
  return r;
}

/**
 * GPS wander, as a receiver actually produces it.
 *
 * NOT independent scatter. A receiver reporting +-13 m does not jump fifteen
 * metres between one fix and the next; its estimate drifts, a metre or two at a
 * time, and is pulled back toward the true position. Modelling it as independent
 * uniform noise would ask the recorder to reject something real GPS never does,
 * and the gate needed to defeat that would also reject a geologist walking slowly.
 *
 * So: a small step each fix, with mean reversion, bounded near the stated
 * accuracy. Seeded, so a failure is the same failure next time.
 */
function wander(seed: number, accuracyM: number) {
  let s = seed, x = 0, y = 0;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) * 2 - 1;
  };
  return () => {
    // Step, then pull 12% of the way home — an excursion of roughly the stated
    // accuracy, reached over several fixes rather than in one.
    x = (x + rnd() * 2.5) * 0.88;
    y = (y + rnd() * 2.5) * 0.88;
    const r = Math.hypot(x, y);
    if (r > accuracyM) { x = (x / r) * accuracyM; y = (y / r) * accuracyM; }
    return { northM: x, eastM: y };
  };
}

/** Distance a config records from the same wander. */
function distanceFromWander(
  config: Partial<typeof DEFAULT_TRACK_CONFIG>, accuracyM: number, fixes = 700,
): number {
  const r = new TrackRecorder(config, () => T0);
  r.begin("fs-w", T0);
  const w = wander(7, accuracyM);
  for (let i = 0; i < fixes; i++) {
    const { northM, eastM } = w();
    r.addFix(fix(northM, eastM, T0 + i * 3_000, accuracyM));
  }
  return r.getStats().distanceM;
}

describe("1. a phone that is not moving draws no traverse", () => {
  test("THE DESK READING: the old gate drew a traverse, the new one does not", () => {
    // Thirty-five minutes of +-13 m wander, the same wander through both gates.
    // Measured on the phone under the old one: about sixty metres of line and
    // "Movement: moving 4.1 km/h", from a device lying on a desk.
    const before = distanceFromWander({ accuracyGateFactor: 0.5 }, 13);
    const after = distanceFromWander({}, 13);

    expect(before).toBeGreaterThan(30);      // the defect, reproduced
    expect(after).toBeLessThan(before / 5);  // and largely gone
    expect(after).toBeLessThan(15);
  });

  test("a worse fix is held to a proportionally wider gate", () => {
    // +-30 m. The gate widens with the uncertainty — 42 m here — so a bad fix
    // cannot buy itself a longer walk. Asserted absolutely rather than against
    // the old gate, because at this accuracy the old one happens to reject
    // everything too and a ratio of zero to zero proves nothing.
    expect(distanceFromWander({}, 30)).toBeLessThan(1);
  });

  test("standing still is never reported as moving time", () => {
    const r = new TrackRecorder({}, () => T0);
    r.begin("fs-still", T0);
    const w = wander(21, 13);
    for (let i = 0; i < 400; i++) {
      const { northM, eastM } = w();
      r.addFix(fix(northM, eastM, T0 + i * 3_000));
    }
    const s = r.getStats();
    expect(s.movingMs).toBe(0);
    expect(s.rejected.stationary).toBeGreaterThan(300);
  });
});

describe("2. real movement is still recorded, and still accurate", () => {
  test("a normal walking pace covers the ground it actually covered", () => {
    // 1.4 m/s due north, a fix every 3 s, for five minutes: 420 m.
    const r = recorder();
    for (let i = 0; i <= 100; i++) {
      r.addFix(fix(i * 4.2, 0, T0 + i * 3_000));
    }
    const s = r.getStats();
    expect(s.distanceM).toBeGreaterThan(400);
    expect(s.distanceM).toBeLessThan(440);
    expect(s.movingMs).toBeGreaterThan(0);
  });

  test("SLOW movement is not mistaken for standing", () => {
    // 0.5 m/s — a geologist working along an outcrop rather than walking to one.
    // Each individual fix moves only 1.5 m, well under the gate; the distance is
    // measured from the last KEPT point, so it accumulates and is recorded.
    const r = recorder();
    for (let i = 0; i <= 200; i++) {
      r.addFix(fix(i * 1.5, 0, T0 + i * 3_000));
    }
    const s = r.getStats();
    expect(s.distanceM).toBeGreaterThan(250);
    expect(s.distanceM).toBeLessThan(320);
  });

  test("walking THROUGH noise still measures the walk", () => {
    // The real case: 1.4 m/s with the receiver wandering +-13 m underneath it.
    // The line will not be perfect and it must not be far wrong.
    const r = new TrackRecorder({}, () => T0);
    r.begin("fs-walk-noise", T0);
    const w = wander(3, 13);
    for (let i = 0; i <= 100; i++) {
      const { northM, eastM } = w();
      r.addFix(fix(i * 4.2 + northM, eastM, T0 + i * 3_000));
    }
    const s = r.getStats();
    expect(s.distanceM).toBeGreaterThan(380);
    expect(s.distanceM).toBeLessThan(500);
  });
});

describe("3. the gate is the displacement-noise threshold, not a taste", () => {
  test("the factor is a·√2, to one decimal", () => {
    expect(DEFAULT_TRACK_CONFIG.accuracyGateFactor).toBeCloseTo(Math.SQRT2, 1);
  });

  test("at a field-typical fix the accuracy term is the one that decides", () => {
    // The whole defect was that it never did: max(10, 13 × 0.5) is 10.
    const { minDistanceM, accuracyGateFactor } = DEFAULT_TRACK_CONFIG;
    expect(13 * accuracyGateFactor).toBeGreaterThan(minDistanceM);
  });

  test("a stop is still visible on the timeline", () => {
    // Rejecting noise must not mean recording nothing: one point per idle window,
    // so a two-hour stop at an outcrop does not read as a gap in the traverse.
    expect(DEFAULT_TRACK_CONFIG.idleResampleMs).toBeLessThanOrEqual(60_000);
  });
});

// Field Exploration Engine — Phase 2 Step 1 unit tests (TrackRecorder).
//
// Pure tests: no expo, no react-native, no timers. Every fix is synthesised, so
// the ingest policy is exercised at its exact thresholds.
import type { FieldFix } from "../field/types";
import {
  DEFAULT_TRACK_CONFIG,
  TrackRecorder,
  haversineM,
  type IngestResult,
  type RejectReason,
} from "../field/trackRecorder";

/** Narrows the ingest union so a rejection can be asserted by reason. */
const rejection = (res: IngestResult): RejectReason | null =>
  res.accepted ? null : res.reason;

// ── Helpers ─────────────────────────────────────────────────────────────────
// Near Mogadishu; at this latitude 1e-5° ≈ 1.11 m north / 1.11 m east.
const BASE_LAT = 2.0469;
const BASE_LNG = 45.3182;
const M_PER_DEG_LAT = 111_195;

const fix = (over: Partial<FieldFix> = {}): FieldFix => ({
  lat: BASE_LAT,
  lng: BASE_LNG,
  accuracy: 8,
  altitude: null,
  speed: null,
  timestamp: 1_000,
  provisional: false,
  ...over,
});

/** A fix `metres` due north of base, at time `t`. */
const north = (metres: number, t: number, over: Partial<FieldFix> = {}): FieldFix =>
  fix({ lat: BASE_LAT + metres / M_PER_DEG_LAT, timestamp: t, ...over });

function recorder(config = {}) {
  const r = new TrackRecorder(config, () => 1_000);
  r.begin("fs-test", 1_000);
  return r;
}

/** Walk `count` legs of `metres`, one every `stepMs`, starting at t=1000. */
function walk(r: TrackRecorder, count: number, metres = 20, stepMs = 10_000) {
  for (let i = 0; i <= count; i++) r.addFix(north(i * metres, 1_000 + i * stepMs));
}

// ── Geometry ────────────────────────────────────────────────────────────────
describe("haversineM", () => {
  test("zero distance for an identical point", () => {
    expect(haversineM({ lat: BASE_LAT, lng: BASE_LNG }, { lat: BASE_LAT, lng: BASE_LNG })).toBe(0);
  });

  test("one degree of latitude is ~111.2 km", () => {
    const d = haversineM({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
    expect(d).toBeGreaterThan(111_100);
    expect(d).toBeLessThan(111_300);
  });

  test("short legs are accurate to well under a metre", () => {
    const d = haversineM({ lat: BASE_LAT, lng: BASE_LNG }, { lat: BASE_LAT + 20 / M_PER_DEG_LAT, lng: BASE_LNG });
    expect(Math.abs(d - 20)).toBeLessThan(0.5);
  });

  test("symmetric", () => {
    const a = { lat: BASE_LAT, lng: BASE_LNG };
    const b = { lat: BASE_LAT + 0.01, lng: BASE_LNG + 0.02 };
    expect(haversineM(a, b)).toBeCloseTo(haversineM(b, a), 9);
  });
});

// ── Ingest policy ───────────────────────────────────────────────────────────
describe("TrackRecorder ingest", () => {
  test("rejects everything before begin()", () => {
    const r = new TrackRecorder({}, () => 1_000);
    expect(r.addFix(fix())).toEqual({ accepted: false, reason: "inactive" });
    expect(r.getStats().pointsStored).toBe(0);
    expect(r.getStats().rejected.inactive).toBe(1);
  });

  test("first real fix opens the track and a segment", () => {
    const r = recorder();
    const res = r.addFix(fix());
    expect(res.accepted).toBe(true);
    if (res.accepted) {
      expect(res.startedSegment).toBe(true);
      expect(res.movedM).toBe(0);
    }
    expect(r.getSegments()).toHaveLength(1);
    expect(r.getStats().distanceM).toBe(0);
  });

  test("provisional fixes never enter the track", () => {
    const r = recorder();
    expect(r.addFix(fix({ provisional: true }))).toEqual({ accepted: false, reason: "provisional" });
    expect(r.getStats().pointsStored).toBe(0);
    expect(r.getStats().rejected.provisional).toBe(1);
  });

  test("accuracy worse than the hard gate is rejected, at the gate is kept", () => {
    const r = recorder();
    expect(r.addFix(fix({ accuracy: DEFAULT_TRACK_CONFIG.maxAccuracyM + 1 }))).toEqual({
      accepted: false,
      reason: "inaccurate",
    });
    expect(r.addFix(fix({ accuracy: DEFAULT_TRACK_CONFIG.maxAccuracyM })).accepted).toBe(true);
  });

  test("a null accuracy is not treated as inaccurate", () => {
    const r = recorder();
    expect(r.addFix(fix({ accuracy: null })).accepted).toBe(true);
  });

  test("out-of-order and duplicate timestamps are rejected as stale", () => {
    const r = recorder();
    r.addFix(north(0, 5_000));
    expect(rejection(r.addFix(north(50, 5_000)))).toBe("stale");
    expect(rejection(r.addFix(north(50, 4_000)))).toBe("stale");
    expect(r.getStats().rejected.stale).toBe(2);
    expect(r.getStats().distanceM).toBe(0);
  });

  test("standing still is dropped, not accumulated as drift", () => {
    const r = recorder();
    r.addFix(north(0, 1_000));
    // Ten jittery fixes inside the gate, five seconds apart.
    for (let i = 1; i <= 10; i++) r.addFix(north(i % 2 === 0 ? 2 : -2, 1_000 + i * 5_000));
    expect(r.getStats().rejected.stationary).toBe(10);
    expect(r.getStats().distanceM).toBe(0);
    expect(r.getStats().pointsStored).toBe(1);
  });

  test("an uncertain fix must move further to count", () => {
    const r = recorder();
    r.addFix(north(0, 1_000, { accuracy: 80 }));
    // 20 m clears the 10 m floor but not 80 m × 0.5 = 40 m.
    expect(rejection(r.addFix(north(20, 11_000, { accuracy: 80 })))).toBe("stationary");
    expect(r.addFix(north(45, 21_000, { accuracy: 80 })).accepted).toBe(true);
  });

  test("standing still still leaves one point per idle window", () => {
    const r = recorder();
    r.addFix(north(0, 1_000));
    r.addFix(north(1, 1_000 + DEFAULT_TRACK_CONFIG.idleResampleMs - 1));
    expect(r.getStats().pointsStored).toBe(1);
    const res = r.addFix(north(1, 1_000 + DEFAULT_TRACK_CONFIG.idleResampleMs));
    expect(res.accepted).toBe(true);
    expect(r.getStats().pointsStored).toBe(2);
    // The resample is a timeline marker, not travel.
    expect(r.getStats().distanceM).toBe(0);
    expect(r.getStats().movingMs).toBe(0);
    expect(r.getSegments()).toHaveLength(1);
  });

  test("a teleport is a spike, and does not poison the distance", () => {
    const r = recorder();
    r.addFix(north(0, 1_000));
    r.addFix(north(20, 11_000));
    // 5 km in 10 s.
    expect(rejection(r.addFix(north(5_020, 21_000)))).toBe("spike");
    expect(r.getStats().rejected.spike).toBe(1);
    expect(r.getStats().distanceM).toBeCloseTo(20, 0);
    // The spike is not adopted as the cursor: the next honest fix still works.
    expect(r.addFix(north(40, 31_000)).accepted).toBe(true);
    expect(r.getStats().distanceM).toBeCloseTo(40, 0);
  });
});

// ── Derived statistics ──────────────────────────────────────────────────────
describe("TrackRecorder stats", () => {
  test("distance sums the legs actually walked", () => {
    const r = recorder();
    walk(r, 5, 20, 10_000); // 5 legs × 20 m
    expect(r.getStats().distanceM).toBeCloseTo(100, 0);
    expect(r.getStats().pointsAccepted).toBe(6);
  });

  test("duration is wall clock; moving time excludes standing", () => {
    const r = recorder();
    r.addFix(north(0, 0));
    r.addFix(north(20, 10_000));            // 2 m/s — travel
    r.addFix(north(21, 130_000));           // idle resample after 2 min standing
    r.addFix(north(41, 140_000));           // travel again
    const s = r.getStats();
    expect(s.durationMs).toBe(140_000);
    expect(s.movingMs).toBe(20_000);        // the two travelling legs only
  });

  test("slow drift over a long gap is not counted as moving time", () => {
    const r = recorder();
    r.addFix(north(0, 0));
    // 12 m over 120 s = 0.1 m/s: it clears the distance gate but is not walking.
    r.addFix(north(12, 120_000));
    expect(r.getStats().distanceM).toBeCloseTo(12, 0);
    expect(r.getStats().movingMs).toBe(0);
  });

  test("relief ignores altitude noise and accumulates real climbs", () => {
    const r = recorder();
    r.addFix(north(0, 0, { altitude: 100 }));
    r.addFix(north(20, 10_000, { altitude: 102 }));   // noise (< 5 m)
    r.addFix(north(40, 20_000, { altitude: 130 }));   // +30
    r.addFix(north(60, 30_000, { altitude: 110 }));   // -20
    const s = r.getStats();
    expect(s.ascentM).toBeCloseTo(30, 5);
    expect(s.descentM).toBeCloseTo(20, 5);
  });

  test("missing altitude leaves relief at zero rather than NaN", () => {
    const r = recorder();
    walk(r, 3);
    const s = r.getStats();
    expect(s.ascentM).toBe(0);
    expect(s.descentM).toBe(0);
  });

  test("bounds cover every accepted point", () => {
    const r = recorder();
    // Legs kept walkable (~250 m per 30 s) so nothing trips the spike gate.
    r.addFix(fix({ timestamp: 0 }));
    r.addFix(fix({ lat: BASE_LAT + 0.001, lng: BASE_LNG - 0.002, timestamp: 30_000 }));
    r.addFix(fix({ lat: BASE_LAT - 0.001, lng: BASE_LNG + 0.002, timestamp: 90_000 }));
    const b = r.getStats().bounds!;
    expect(b.minLat).toBeCloseTo(BASE_LAT - 0.001, 6);
    expect(b.maxLat).toBeCloseTo(BASE_LAT + 0.001, 6);
    expect(b.minLng).toBeCloseTo(BASE_LNG - 0.002, 6);
    expect(b.maxLng).toBeCloseTo(BASE_LNG + 0.002, 6);
  });

  test("every rejection is counted, so an empty track is explainable", () => {
    const r = recorder();
    r.addFix(fix({ provisional: true }));
    r.addFix(fix({ accuracy: 500 }));
    const rej = r.getStats().rejected;
    expect(rej.provisional).toBe(1);
    expect(rej.inaccurate).toBe(1);
    expect(r.getStats().pointsAccepted).toBe(0);
  });
});

// ── Segmentation ────────────────────────────────────────────────────────────
describe("TrackRecorder segments", () => {
  test("a pause splits the line and no distance crosses the gap", () => {
    const r = recorder();
    r.addFix(north(0, 0));
    r.addFix(north(20, 10_000));
    r.breakSegment("pause");
    r.addFix(north(2_000, 20_000)); // resumed 2 km away — a bus ride, not a walk
    r.addFix(north(2_020, 30_000));
    const segs = r.getSegments();
    expect(segs).toHaveLength(2);
    expect(segs[0].closedBy).toBe("pause");
    expect(segs[0].endedAt).toBe(10_000);
    expect(segs[1].startedAt).toBe(20_000);
    // 20 m + 20 m; the 2 km gap is not walked distance.
    expect(r.getStats().distanceM).toBeCloseTo(40, 0);
  });

  test("points carry the segment they belong to", () => {
    const r = recorder();
    r.addFix(north(0, 0));
    r.breakSegment("background");
    r.addFix(north(30, 10_000));
    expect(r.getPoints().map((p) => p.segment)).toEqual([0, 1]);
  });

  test("a long silence auto-breaks the segment", () => {
    const r = recorder();
    r.addFix(north(0, 0));
    r.addFix(north(20, 10_000));
    const gap = DEFAULT_TRACK_CONFIG.segmentGapMs + 1;
    r.addFix(north(40, 10_000 + gap));
    const segs = r.getSegments();
    expect(segs).toHaveLength(2);
    expect(segs[0].closedBy).toBe("signal-loss");
    expect(r.getStats().distanceM).toBeCloseTo(20, 0);
  });

  test("a break before the first point does not create an empty segment", () => {
    const r = recorder();
    r.breakSegment("pause");
    expect(r.getSegments()).toHaveLength(0);
    r.addFix(north(0, 0));
    expect(r.getSegments()).toHaveLength(1);
    expect(r.getSegments()[0].pointCount).toBe(1);
  });

  test("repeated breaks do not stack empty segments", () => {
    const r = recorder();
    r.addFix(north(0, 0));
    r.breakSegment("pause");
    r.breakSegment("pause");
    r.breakSegment("background");
    expect(r.getSegments()).toHaveLength(1);
    r.addFix(north(30, 10_000));
    expect(r.getSegments()).toHaveLength(2);
  });

  test("per-segment distance sums to the total", () => {
    const r = recorder();
    walk(r, 3, 20, 10_000);
    r.breakSegment("pause");
    r.addFix(north(500, 100_000));
    r.addFix(north(520, 110_000));
    const total = r.getSegments().reduce((a, s) => a + s.distanceM, 0);
    expect(total).toBeCloseTo(r.getStats().distanceM, 6);
  });
});

// ── Bounded memory ──────────────────────────────────────────────────────────
describe("TrackRecorder capacity", () => {
  test("thinning halves storage without shortening the traverse", () => {
    const r = recorder({ maxPoints: 20 });
    // 50 m legs stay clear of the widened gate, so every fix is still accepted.
    walk(r, 40, 50, 10_000); // 41 fixes, 40 legs × 50 m
    const s = r.getStats();
    expect(s.pointsAccepted).toBe(41);
    expect(s.pointsStored).toBeLessThanOrEqual(21);
    expect(s.thinCount).toBeGreaterThan(0);
    // The walked distance is accumulated at ingest, so thinning cannot shrink it.
    expect(s.distanceM).toBeCloseTo(2_000, 0);
  });

  test("storage stays bounded across a very long traverse", () => {
    const r = recorder({ maxPoints: 50 });
    walk(r, 2_000, 50, 10_000);
    expect(r.getStats().pointsStored).toBeLessThanOrEqual(51);
    expect(r.getPoints()).toEqual([...r.getPoints()].sort((a, b) => a.t - b.t));
  });

  test("thinning widens the movement gate instead of dropping the start", () => {
    const r = recorder({ maxPoints: 20 });
    const first = r.getPoints()[0];
    walk(r, 40, 20, 10_000);
    expect(r.getStats().resolutionM).toBe(
      DEFAULT_TRACK_CONFIG.minDistanceM * 2 ** r.getStats().thinCount,
    );
    // The first point of the traverse survives; the oldest data is not evicted.
    expect(r.getPoints()[0].t).toBe(1_000);
    expect(first).toBeUndefined();
  });

  test("segment endpoints survive thinning", () => {
    const r = recorder({ maxPoints: 20 });
    walk(r, 20, 20, 10_000);
    r.breakSegment("pause");
    for (let i = 1; i <= 20; i++) r.addFix(north(5_000 + i * 20, 500_000 + i * 10_000));
    const pts = r.getPoints();
    for (const seg of r.getSegments()) {
      const inSeg = pts.filter((p) => p.segment === seg.index);
      expect(inSeg.length).toBeGreaterThanOrEqual(2);
      expect(inSeg[0].t).toBe(seg.startedAt);
    }
  });
});

// ── Lifecycle & read side ───────────────────────────────────────────────────
describe("TrackRecorder lifecycle", () => {
  test("begin() discards the previous session", () => {
    const r = recorder();
    walk(r, 3);
    r.begin("fs-second", 99_000);
    const s = r.getStats();
    expect(s.pointsStored).toBe(0);
    expect(s.distanceM).toBe(0);
    expect(s.rejected.stationary).toBe(0);
    expect(r.getSnapshot().sessionId).toBe("fs-second");
    expect(r.getSegments()).toHaveLength(0);
  });

  test("end() closes the open segment and stops accepting fixes", () => {
    const r = recorder();
    walk(r, 2);
    r.end(90_000);
    expect(r.isRecording()).toBe(false);
    expect(r.getSegments()[0].endedAt).toBe(21_000);
    expect(r.addFix(north(500, 100_000)).accepted).toBe(false);
    // The traverse stays readable after the session ends — that is the handoff.
    expect(r.getStats().distanceM).toBeCloseTo(40, 0);
    expect(r.getSnapshot().endedAt).toBe(90_000);
  });

  test("end() is idempotent and breakSegment() after it is inert", () => {
    const r = recorder();
    walk(r, 2);
    r.end(90_000);
    r.end(95_000);
    r.breakSegment("manual");
    expect(r.getSnapshot().endedAt).toBe(90_000);
    expect(r.getSegments()).toHaveLength(1);
  });

  test("snapshot identity is stable between mutations and changes after one", () => {
    const r = recorder();
    r.addFix(north(0, 0));
    const a = r.getSnapshot();
    expect(r.getSnapshot()).toBe(a);
    r.addFix(north(20, 10_000));
    const b = r.getSnapshot();
    expect(b).not.toBe(a);
    expect(b.stats.pointsStored).toBe(2);
  });

  test("subscribers are notified on accepted fixes and not on rejections", () => {
    const r = recorder();
    let calls = 0;
    const unsub = r.subscribe(() => { calls++; });
    r.addFix(north(0, 0));
    expect(calls).toBe(1);
    r.addFix(north(1, 5_000)); // stationary ⇒ rejected
    expect(calls).toBe(1);
    r.addFix(north(20, 10_000));
    expect(calls).toBe(2);
    unsub();
    r.addFix(north(40, 20_000));
    expect(calls).toBe(2);
  });

  test("the snapshot survives JSON export unchanged", () => {
    const r = recorder();
    walk(r, 3);
    r.breakSegment("manual");
    r.addFix(north(500, 200_000));
    const snap = r.getSnapshot();
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });
});

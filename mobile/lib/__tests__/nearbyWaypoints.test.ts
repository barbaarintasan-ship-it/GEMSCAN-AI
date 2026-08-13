// SLICE 4 — previous field evidence near where you are standing.
//
// The failure this exists to stop: a geologist walked back into a valley they had
// worked before, and the app — which held the photographs and the bagged sample for
// that exact spot — said "No sample recorded". Absence of a panel read as absence of
// evidence.
//
// CONTEXT ONLY. The last describe here is the one that matters most: nothing in this
// slice reaches the prospectivity engine. Scoring already counts field observations
// once, through localEvidence; counting them again here would inflate a site for
// having been visited.
import {
  NEARBY_RADIUS_M, nearbyWaypoints, summariseNearby,
} from "../field/nearbyWaypoints";
import type { Waypoint, WaypointSample } from "../field/waypointTypes";
import { haversineM } from "../../../shared/geo-core/geo/spatial";

const NOW = Date.parse("2026-08-11T09:00:00.000Z");
const HERE = { lat: 2.0469, lng: 45.3182 };

/**
 * Metres north, CALIBRATED against the same haversine the code uses.
 *
 * A flat 110,574 m per degree was the first attempt and it was 0.56% out against
 * the mean-radius sphere `haversineM` assumes — enough that a fixture asking for
 * 249 m produced 250.4 m and fell outside a 250 m boundary. Measuring the degree
 * here means a fixture in metres really is metres, whatever constant the spatial
 * code settles on.
 */
const DEG_PER_M = (() => {
  const probeDeg = 0.01;
  const probeM = haversineM(HERE, { lat: HERE.lat + probeDeg, lng: HERE.lng });
  return probeDeg / probeM;
})();
const northBy = (m: number) => ({ lat: HERE.lat + m * DEG_PER_M, lng: HERE.lng });

const SAMPLE: WaypointSample = {
  sampleId: "LW-20260811-003", sampleType: "rock",
  collectionMethod: "outcrop", description: "White quartz vein with iron staining",
};

function waypoint(over: Partial<Waypoint> & { at?: { lat: number; lng: number } } = {}): Waypoint {
  const { at, ...rest } = over;
  return {
    id: "w1", sessionId: "ex-1", trackId: "ex-1", missionId: null,
    type: "outcrop", name: null, notes: "",
    position: at
      ? {
          lat: at.lat, lng: at.lng, accuracyM: 6, altitudeM: 700,
          fixedAt: NOW - 1_000, ageMs: 1_000, provisional: false,
        }
      : null,
    heading: null, photos: [], sample: null,
    capturedAt: NOW, updatedAt: NOW, syncState: "local", deletedAt: null,
    ...rest,
  };
}

const photos = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `p${i}`, uri: `file:///app/waypoints/p${i}.jpg`, capturedAt: NOW, remotePath: null,
  }));

describe("what is within reach", () => {
  test("the default radius is 250 m", () => {
    expect(NEARBY_RADIUS_M).toBe(250);
  });

  test("a waypoint 100 m away APPEARS", () => {
    const near = nearbyWaypoints([waypoint({ id: "close", at: northBy(100) })], HERE);
    expect(near.map((w) => w.id)).toEqual(["close"]);
    expect(near[0].distanceM).toBeGreaterThan(95);
    expect(near[0].distanceM).toBeLessThan(105);
  });

  test("a waypoint 300 m away does NOT appear", () => {
    expect(nearbyWaypoints([waypoint({ id: "far", at: northBy(300) })], HERE)).toEqual([]);
  });

  test("the boundary is INCLUSIVE — just inside is in, just outside is out", () => {
    // Tested either SIDE of the boundary rather than on it. The comparison is
    // `distanceM > radiusM`, so 250 m exactly counts as within reach — but a
    // fixture cannot reliably land on it: calibrating metres through a float
    // round-trip lands at 250.00000000000003, which is genuinely greater than 250.
    // Exactly 250 m never happens in the field either, so the useful question is
    // whether each side falls the right way.
    const inside = nearbyWaypoints([waypoint({ id: "in", at: northBy(249.9) })], HERE);
    expect(inside.map((w) => w.id)).toEqual(["in"]);
    expect(inside[0].distanceM).toBeLessThanOrEqual(NEARBY_RADIUS_M);

    const outside = nearbyWaypoints([waypoint({ id: "out", at: northBy(250.1) })], HERE);
    expect(outside).toEqual([]);
  });

  test("a wider radius can be asked for", () => {
    const wps = [waypoint({ id: "far", at: northBy(800) })];
    expect(nearbyWaypoints(wps, HERE)).toEqual([]);
    expect(nearbyWaypoints(wps, HERE, 1_000).map((w) => w.id)).toEqual(["far"]);
  });
});

describe("ordering and content", () => {
  test("NEAREST FIRST", () => {
    const near = nearbyWaypoints([
      waypoint({ id: "mid", at: northBy(120) }),
      waypoint({ id: "closest", at: northBy(15) }),
      waypoint({ id: "edge", at: northBy(240) }),
    ], HERE);
    expect(near.map((w) => w.id)).toEqual(["closest", "mid", "edge"]);
  });

  test("at the same distance, the more recent comes first", () => {
    const near = nearbyWaypoints([
      waypoint({ id: "old", at: northBy(100), capturedAt: NOW - 30 * 86_400_000 }),
      waypoint({ id: "new", at: northBy(100), capturedAt: NOW - 3_600_000 }),
    ], HERE);
    expect(near.map((w) => w.id)).toEqual(["new", "old"]);
  });

  test("every field the panel needs comes back", () => {
    const near = nearbyWaypoints([waypoint({
      id: "w9", type: "quartz-vein", at: northBy(80),
      sample: SAMPLE, photos: photos(8),
      capturedAt: NOW - 21 * 86_400_000, missionId: "ms-abc",
    })], HERE);
    expect(near).toHaveLength(1);
    const w = near[0];
    expect(w.type).toBe("quartz-vein");
    expect(w.photoCount).toBe(8);
    expect(w.capturedAt).toBe(NOW - 21 * 86_400_000);
    expect(w.missionId).toBe("ms-abc");
    // THE SENTENCE THIS SLICE EXISTS TO PREVENT: "No sample recorded" over ground
    // that has one. The sample comes back whole, with the label on the bag.
    expect(w.sample!.sampleId).toBe("LW-20260811-003");
    expect(w.sample!.sampleType).toBe("rock");
    expect(w.sample!.collectionMethod).toBe("outcrop");
    expect(w.sample!.description).toContain("quartz");
  });

  test("a waypoint with no sample reports null, not a fabricated one", () => {
    const near = nearbyWaypoints([waypoint({ id: "w1", at: northBy(50) })], HERE);
    expect(near[0].sample).toBeNull();
    expect(near[0].photoCount).toBe(0);
  });
});

describe("what is skipped, and why", () => {
  test("a waypoint with NO recorded position is skipped", () => {
    // The observation is real, but it cannot be placed — and reporting it at a
    // distance nobody measured would be an invention.
    expect(nearbyWaypoints([waypoint({ id: "nofix" })], HERE)).toEqual([]);
  });

  test("a deleted waypoint is gone", () => {
    expect(nearbyWaypoints([
      waypoint({ id: "d1", at: northBy(30), deletedAt: NOW }),
    ], HERE)).toEqual([]);
  });

  test("an empty record set yields an empty list, not a throw", () => {
    expect(nearbyWaypoints([], HERE)).toEqual([]);
  });
});

describe("mission filtering", () => {
  const wps = [
    waypoint({ id: "a1", at: northBy(40), missionId: "ms-a" }),
    waypoint({ id: "b1", at: northBy(60), missionId: "ms-b" }),
    waypoint({ id: "none", at: northBy(80), missionId: null }),
  ];

  test("everything within reach by default, whatever its mission", () => {
    expect(nearbyWaypoints(wps, HERE).map((w) => w.id)).toEqual(["a1", "b1", "none"]);
  });

  test("one mission only, when asked", () => {
    expect(nearbyWaypoints(wps, HERE, NEARBY_RADIUS_M, { missionId: "ms-b" }).map((w) => w.id))
      .toEqual(["b1"]);
  });

  test("null means the ones recorded OUTSIDE a mission", () => {
    // A geologist records things between missions, and those are still their work.
    expect(nearbyWaypoints(wps, HERE, NEARBY_RADIUS_M, { missionId: null }).map((w) => w.id))
      .toEqual(["none"]);
  });

  test("the mission association is always reported", () => {
    for (const w of nearbyWaypoints(wps, HERE)) {
      expect(Object.hasOwn(w, "missionId")).toBe(true);
    }
  });
});

describe("the summary the panel heading uses", () => {
  test("it counts waypoints, photographs and samples, and the nearest distance", () => {
    const near = nearbyWaypoints([
      waypoint({ id: "w1", at: northBy(30), photos: photos(8), sample: SAMPLE }),
      waypoint({ id: "w2", at: northBy(120), photos: photos(2) }),
      waypoint({ id: "w3", at: northBy(200), sample: SAMPLE }),
    ], HERE);
    const s = summariseNearby(near);
    expect(s.count).toBe(3);
    expect(s.photoCount).toBe(10);
    expect(s.sampleCount).toBe(2);
    expect(s.nearestM).toBeLessThan(35);
  });

  test("nothing nearby summarises to nothing, with a null distance", () => {
    expect(summariseNearby([])).toEqual({
      count: 0, photoCount: 0, sampleCount: 0, nearestM: null,
    });
  });
});

describe("CONTEXT ONLY — this reaches no part of scoring", () => {
  test("the module IMPORTS nothing from the engine", () => {
    // Structural, and the point of the slice. If this file ever pulled in
    // localEvidence, targeting or confidence, past visits would start moving a
    // site's score — and a site would become more prospective for having been
    // walked over.
    //
    // Only the IMPORT LINES are checked. The first attempt grepped the whole file
    // and failed on its own header comment, which names those modules precisely to
    // say it does not use them — a test that cannot tell an import from a sentence
    // about an import.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "field", "nearbyWaypoints.ts"), "utf8",
    ) as string;
    // Every import statement, and nothing that is merely written ABOUT one.
    // The first attempt read the whole file and tripped on its own header
    // comment, which names these modules precisely to say it does not use them.
    const imports = (src.match(/^import[^;]*;$/gm) ?? []).join(" | ");
    for (const forbidden of [
      "localEvidence", "prospectivityEvidence", "computeConfidence",
      "targeting", "collapseGroups", "confidence",
    ]) {
      expect(imports).not.toContain(forbidden);
    }
    // What it MAY depend on: spatial arithmetic and the waypoint types.
    expect(imports).toContain("geo/spatial");
    expect(imports).toContain("waypointTypes");
  });

  test("it returns plain data — no weights, no scores, no evidence items", () => {
    const near = nearbyWaypoints([
      waypoint({ id: "w1", at: northBy(30), photos: photos(8), sample: SAMPLE }),
    ], HERE);
    const keys = Object.keys(near[0]).sort();
    expect(keys).toEqual(
      ["capturedAt", "distanceM", "id", "missionId", "photoCount", "sample", "type"],
    );
    // Nothing that could be mistaken for a scoring contribution.
    for (const bad of ["weight", "score", "signal", "tier", "role"]) {
      expect(keys).not.toContain(bad);
    }
  });

  test("no scoring signal was created for sample-location — checked by BEHAVIOUR", () => {
    // Asserted against what the code DOES, not against its source text. Reading the
    // table as a string failed on the comment that explains why sample-location is
    // absent from it — the same mistake as above, and behaviour is the better
    // question anyway.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { makeWaypointEvidenceSource } = require("../exploration/localEvidence");
    const at = { lat: HERE.lat, lng: HERE.lng };
    const one = (type: Waypoint["type"]) =>
      makeWaypointEvidenceSource({
        visible: () => [waypoint({ id: type, type, at, sample: SAMPLE })],
      }).observationsNear(at.lat, at.lng, 5_000);

    // A sample-location produces no evidence item at all.
    expect(one("sample-location")).toEqual([]);
    // The ten that score still do, at the weights they always had.
    const expected: Array<[Waypoint["type"], number]> = [
      ["sulfides", 0.85], ["gossan", 0.8], ["quartz-vein", 0.7], ["vein", 0.65],
      ["alteration", 0.6], ["contact", 0.5], ["fault", 0.5], ["float", 0.45],
      ["outcrop", 0.3], ["other", 0.2],
    ];
    for (const [type, weight] of expected) {
      const obs = one(type);
      expect(obs).toHaveLength(1);
      expect(obs[0].weight).toBeCloseTo(weight, 5);
    }
  });
});

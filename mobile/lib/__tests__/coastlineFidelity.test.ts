// The coastline is drawn at full resolution — because it is a measurement.
//
// WHY THIS FILE EXISTS. A geologist reported that Boosaaso appeared inland. Three
// candidates were measured against the app's own code: the Esri tile pixel (0 m),
// the strip reprojection (7.3 m worst case over every zoom, under 0.5 m at any
// zoom fieldwork happens at), and the drawn coastline. The coastline was the
// culprit, and the app had caused it: MAX_RING_VERTICES, a budget written for
// Macrostrat units that run to thousands of vertices, was also being applied to
// the shoreline. It kept 282 of the pack's 843 vertices and moved the shore at
// Boosaaso from 0.61 km away to 1.76 km — 1.15 km of displacement the data never
// contained, which at traverse zoom is over 400 px on a 400 px screen.
//
// A geology contact may be smoothed. A shoreline may not: the question asked of
// it is "which side of this line am I on", so its position IS its content.
//
// These tests read the REAL bundled pack rather than a fixture. The invariant is
// about the shipped coastline, and a fixture would let the shipped one rot.
import { buildScene, MAX_RING_VERTICES, MAX_COASTLINE_VERTICES } from "../geo/mapScene";
import type { PackData, PackGeologyUnit } from "../../../shared/geo-core/pack/types.ts";

const landPack = require("../../assets/geo-pack/land.json") as {
  rows: Array<Omit<PackGeologyUnit, "attributes"> & { attributes?: null }>;
};

const M_LAT = 111_195;

/** Boosaaso port. The town the field report was about. */
const BOOSAASO = { lat: 11.2842, lng: 49.1816 };

/** Distance in metres from a point to the nearest coastline segment. */
function metresToShore(
  at: { lat: number; lng: number },
  rings: Array<Array<[number, number]>>,
): number {
  const kLng = M_LAT * Math.cos((at.lat * Math.PI) / 180);
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      // Local metres about `at`, so `at` is the origin.
      const ax = (ring[i][0] - at.lng) * kLng, ay = (ring[i][1] - at.lat) * M_LAT;
      const bx = (ring[i + 1][0] - at.lng) * kLng, by = (ring[i + 1][1] - at.lat) * M_LAT;
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy;
      // True projection onto the segment, clamped — not the nearest vertex.
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2));
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < best) best = d;
    }
  }
  return best;
}

function packWithRealCoastline(): PackData {
  const ring: Array<[number, number]> = [];
  // A geology unit with enough vertices to prove it is still being thinned.
  for (let i = 0; i < 3_000; i++) {
    const a = (i / 3_000) * Math.PI * 2;
    ring.push([49.18 + 0.3 * Math.cos(a), 11.28 + 0.3 * Math.sin(a)]);
  }
  ring.push(ring[0]);

  return {
    geology: [{
      id: "g1", name: "Basement", kind: "metamorphic", source: "Macrostrat",
      attributes: null, rings: [ring], isPolygon: true,
      bbox: [48.88, 10.98, 49.48, 11.58],
    }],
    land: landPack.rows.map((r) => ({ ...r, attributes: null })) as PackGeologyUnit[],
    occurrences: [], knowledge: [], structures: [], community: [],
    mapFeatures: [], terrain: [], associations: [], rules: [],
    commodities: [], assemblages: [],
  } as unknown as PackData;
}

// A scene wide enough to hold the Boosaaso stretch of coast.
const scene = buildScene(packWithRealCoastline(), BOOSAASO, 40_000);
const drawnLand = scene.land.map((p) => p.rings).flat() as Array<Array<[number, number]>>;
const packLand = landPack.rows.flatMap((r) => r.rings) as Array<Array<[number, number]>>;

describe("the shipped coastline reaches the map intact", () => {
  test("the pack carries a coastline at all", () => {
    expect(drawnLand.length).toBeGreaterThan(0);
  });

  test("every vertex the pack holds is drawn — none are thinned away", () => {
    // Not "approximately all". The whole defect was a silent 66% reduction, so
    // the assertion is equality: what shipped is what is drawn.
    const drawnCount = drawnLand.reduce((n, r) => n + r.length, 0);
    const packCount = packLand
      .filter((r) => drawnLand.some((d) => d.length === r.length || d[0]?.[0] === r[0]?.[0]))
      .reduce((n, r) => n + r.length, 0);
    expect(drawnCount).toBe(packCount);
  });

  test("the ceiling is high enough to be no ceiling for this pack", () => {
    const biggest = Math.max(...packLand.map((r) => r.length));
    expect(MAX_COASTLINE_VERTICES).toBeGreaterThan(biggest);
  });

  test("each ring still closes — an open coastline floods the land fill", () => {
    for (const ring of drawnLand) {
      expect(ring[ring.length - 1]).toEqual(ring[0]);
    }
  });
});

describe("Boosaaso is on the coast, where it is", () => {
  // The field report, as a number. Boosaaso is a port: its centre is under a
  // kilometre from its own water, and the drawn shoreline has to agree.
  test("the drawn shoreline passes within 700 m of the town", () => {
    expect(metresToShore(BOOSAASO, drawnLand)).toBeLessThan(700);
  });

  test("thinning to the geology budget would have put it over 1.7 km out", () => {
    // The regression itself, kept as evidence. If someone reinstates the budget
    // for land, this is the number they are reinstating.
    const thinned = packLand.map((ring) => {
      if (ring.length <= MAX_RING_VERTICES) return ring;
      const step = Math.ceil(ring.length / MAX_RING_VERTICES);
      const out: Array<[number, number]> = [];
      for (let i = 0; i < ring.length; i += step) out.push(ring[i]);
      const last = ring[ring.length - 1];
      if (out[out.length - 1] !== last) out.push(last);
      return out;
    });
    expect(metresToShore(BOOSAASO, thinned)).toBeGreaterThan(1_700);
  });
});

describe("geology is left exactly as it was", () => {
  // The coastline got its own budget; it must not have leaked into the layer the
  // original budget was written for.
  test("a 3000-vertex unit is still thinned for drawing", () => {
    expect(scene.polygons[0].rings[0].length).toBeLessThanOrEqual(MAX_RING_VERTICES + 1);
  });

  test("the geology budget itself is unchanged", () => {
    expect(MAX_RING_VERTICES).toBe(400);
  });
});

// The interactive map's data selection.
//
// The projection now happens inside the map surface, so what is testable here
// is the thing that decides what the geologist can see at all — and the
// thinning that keeps a real Macrostrat unit from stalling the map.
import { buildScene, sceneCovers, MAX_RING_VERTICES, SCENE_MARGIN } from "../geo/mapScene";
import type { PackData } from "../../../shared/geo-core/pack/types.ts";

const HERE = { lat: 9.5, lng: 49.0 };

function bigRing(n: number): Array<[number, number]> {
  // A closed ring around HERE with `n` vertices, like a real mapped unit.
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([HERE.lng + 0.3 * Math.cos(a), HERE.lat + 0.3 * Math.sin(a)]);
  }
  out.push(out[0]);
  return out;
}

function pack(overrides: Partial<PackData> = {}): PackData {
  return {
    geology: [{
      id: "g1", name: "Basement", kind: "metamorphic", source: "Macrostrat",
      attributes: { color: "#AABBCC" },
      rings: [bigRing(3000)],
      bbox: [HERE.lng - 0.3, HERE.lat - 0.3, HERE.lng + 0.3, HERE.lat + 0.3],
      isPolygon: true,
    }],
    occurrences: [{
      id: "o1", name: "Gold", commodity_key: "gold", deposit_type: null,
      host_rocks: null, lat: HERE.lat + 0.01, lng: HERE.lng, dataset_id: "d",
      source: "USGS MRDS", version: null, reference: null, cell: "c",
    }],
    knowledge: [], structures: [], community: [],
    mapFeatures: [
      {
        id: "f1", kind: "fault", name: "F", source: "macrostrat_lines", attributes: null,
        lines: [[[HERE.lng + 0.01, HERE.lat - 0.05], [HERE.lng + 0.01, HERE.lat + 0.05]]],
        bbox: [HERE.lng + 0.01, HERE.lat - 0.05, HERE.lng + 0.01, HERE.lat + 0.05],
      },
      {
        id: "c1", kind: "contact", name: "C", source: "macrostrat_lines", attributes: null,
        lines: [[[HERE.lng - 0.01, HERE.lat - 0.05], [HERE.lng - 0.01, HERE.lat + 0.05]]],
        bbox: [HERE.lng - 0.01, HERE.lat - 0.05, HERE.lng - 0.01, HERE.lat + 0.05],
      },
    ],
    terrain: [
      { cell: "t1", lat: HERE.lat, lng: HERE.lng, elevationM: 500, slopeDeg: 4, aspectDeg: null, reliefM: 20, morphology: "slope", drainageDistM: null },
      { cell: "t2", lat: HERE.lat + 0.01, lng: HERE.lng, elevationM: 900, slopeDeg: 9, aspectDeg: null, reliefM: 40, morphology: "ridge", drainageDistM: null },
    ],
    associations: [], rules: [], commodities: [], assemblages: [], land: [],
    ...overrides,
  };
}

describe("buildScene", () => {
  const scene = buildScene(pack(), HERE, 2_000);

  test("prepares more ground than the first view, so panning does not go blank", () => {
    const halfWidthDeg = (scene.bbox[3] - scene.bbox[1]) / 2;
    const expected = (2_000 * SCENE_MARGIN) / 111_195;
    expect(halfWidthDeg).toBeCloseTo(expected, 4);
  });

  test("faults are separated from other lines — only faults drive targeting", () => {
    expect(scene.faults.map((f) => f.id)).toEqual(["f1"]);
    expect(scene.otherLines.map((f) => f.id)).toEqual(["c1"]);
  });

  test("bedrock keeps Macrostrat's own legend colour", () => {
    expect(scene.polygons[0].color).toBe("#AABBCC");
  });

  test("a unit far larger than the view is still included", () => {
    const tight = buildScene(pack(), HERE, 50);
    expect(tight.polygons).toHaveLength(1);
  });
});

describe("thinning keeps the map drawable", () => {
  test("a 3000-vertex unit is reduced for drawing", () => {
    const scene = buildScene(pack(), HERE, 2_000);
    expect(scene.polygons[0].rings[0].length).toBeLessThanOrEqual(MAX_RING_VERTICES + 1);
  });

  test("the ring still closes — a thinned boundary must not become an open shape", () => {
    const ring = buildScene(pack(), HERE, 2_000).polygons[0].rings[0];
    expect(ring[ring.length - 1]).toEqual(ring[0]);
  });

  test("a small ring is left exactly alone", () => {
    const p = pack();
    const small: Array<[number, number]> = [
      [49.0, 9.4], [49.1, 9.4], [49.1, 9.6], [49.0, 9.6], [49.0, 9.4],
    ];
    p.geology[0] = { ...p.geology[0], rings: [small] };
    expect(buildScene(p, HERE, 2_000).polygons[0].rings[0]).toEqual(small);
  });
});

describe("terrain shading", () => {
  test("relief is normalised across the scene", () => {
    const scene = buildScene(pack(), HERE, 2_000);
    const shades = scene.terrain.map((t) => t.shade).sort();
    expect(shades[0]).toBe(0);
    expect(shades[shades.length - 1]).toBe(1);
    expect(scene.elevationRange).toEqual({ minM: 500, maxM: 900 });
  });

  test("flat ground renders neutral rather than being given invented relief", () => {
    const p = pack();
    p.terrain = p.terrain.map((t) => ({ ...t, elevationM: 500 }));
    for (const t of buildScene(p, HERE, 2_000).terrain) expect(t.shade).toBe(0.5);
  });
});

describe("sceneCovers", () => {
  const scene = buildScene(pack(), HERE, 2_000);

  test("the centre is covered", () => {
    expect(sceneCovers(scene, HERE)).toBe(true);
  });

  test("approaching the edge triggers a rebuild BEFORE the map runs out", () => {
    const nearEdge = { lat: scene.bbox[3] - 1e-5, lng: HERE.lng };
    expect(sceneCovers(scene, nearEdge)).toBe(false);
  });

  test("well outside is not covered", () => {
    expect(sceneCovers(scene, { lat: 2.0, lng: 45.3 })).toBe(false);
  });
});

describe("an empty pack produces an empty scene, not a broken one", () => {
  const empty: PackData = {
    geology: [], occurrences: [], knowledge: [], structures: [], community: [],
    mapFeatures: [], terrain: [], associations: [], rules: [], commodities: [], assemblages: [], land: [],
  };
  const scene = buildScene(empty, HERE, 2_000);

  test("every collection is present and empty", () => {
    expect(scene.polygons).toEqual([]);
    expect(scene.faults).toEqual([]);
    expect(scene.occurrences).toEqual([]);
    expect(scene.terrain).toEqual([]);
    expect(scene.elevationRange).toBeNull();
  });
});

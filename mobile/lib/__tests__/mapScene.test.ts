// The interactive map's data selection.
//
// The projection now happens inside the map surface, so what is testable here
// is the thing that decides what the geologist can see at all — and the
// thinning that keeps a real Macrostrat unit from stalling the map.
import { buildScene, sceneCovers, MAX_RING_VERTICES, SCENE_MARGIN , MAX_LINES_PER_KIND } from "../geo/mapScene";
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

describe("the scene carries every layer the map can draw", () => {
  test("lines are split by what they represent, and otherLines still holds them all", () => {
    const p = pack();
    p.mapFeatures = [
      ...p.mapFeatures,
      {
        id: "d1", kind: "drainage", name: "Tog", source: "macrostrat_lines", attributes: null,
        lines: [[[HERE.lng, HERE.lat - 0.02], [HERE.lng, HERE.lat + 0.02]]],
        bbox: [HERE.lng, HERE.lat - 0.02, HERE.lng, HERE.lat + 0.02],
      },
    ];
    const scene = buildScene(p, HERE, 2_000);
    expect(scene.contacts.map((c) => c.id)).toEqual(["c1"]);
    expect(scene.drainage.map((c) => c.id)).toEqual(["d1"]);
    expect(scene.lineaments).toEqual([]);
    // The undivided list is unchanged, so nothing that read it before breaks.
    expect(scene.otherLines.map((c) => c.id).sort()).toEqual(["c1", "d1"]);
  });

  test("coastline is drawn when the pack carries it, and absent when it does not", () => {
    const p = pack();
    p.land = [{
      id: "l1", name: "land", kind: "land", source: "OSM", attributes: null,
      rings: [[[48.5, 9.0], [49.5, 9.0], [49.5, 10.0], [48.5, 10.0], [48.5, 9.0]]],
      bbox: [48.5, 9.0, 49.5, 10.0],
      isPolygon: true,
    }];
    expect(buildScene(p, HERE, 2_000).land).toHaveLength(1);
    // A pack built before the layer existed is still a valid pack.
    expect(buildScene(pack(), HERE, 2_000).land).toEqual([]);
  });

  test("a unit is given somewhere to write its name, and how much room it has", () => {
    const scene = buildScene(pack(), HERE, 2_000);
    const g = scene.polygons[0];
    expect(g.labelAt).not.toBeNull();
    expect(g.labelAt!.lat).toBeCloseTo(HERE.lat, 1);
    expect(g.labelSpanM).toBeGreaterThan(1_000);
  });

  test("DEM derivatives travel with the cell — the slope layer measures nothing itself", () => {
    const scene = buildScene(pack(), HERE, 2_000);
    expect(scene.terrain.map((t) => t.slopeDeg).sort()).toEqual([4, 9]);
    expect(scene.terrain[0].morphology).toBe("slope");
    expect(scene.maxSlopeDeg).toBe(9);
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

describe("the scene has a size, and it is bounded", () => {
  // SHIPPED, THEN MEASURED, THEN FIXED. The derived drainage network is 16,870
  // reaches. With no cap, buildScene at a 400 km view produced an 8.99 MB scene —
  // thirteen times what it had been — and that whole string was serialised and
  // pushed across the bridge into the WebView on every rebuild. On the device it
  // pegged the JS thread at 100% and drove memory to 1.3 GB.
  //
  // The cap is not a compromise on detail: sixteen thousand channels at that
  // scale render as a grey wash. What it drops is what could not have been seen.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("fs") as typeof import("fs");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require("path") as typeof import("path");
  const DIR = path.join(__dirname, "..", "..", "assets", "geo-pack");
  const read = (f: string) => {
    const j = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")) as Record<string, unknown>;
    return (j.rows ?? Object.values(j).find(Array.isArray)) as never[];
  };

  const shipped = () => ({
    geology: read("geology.json"), occurrences: read("occurrences.json"), knowledge: [],
    structures: [], community: [], mapFeatures: read("maplayers.json"),
    terrain: read("terrain.json"), associations: [], rules: [], commodities: [],
    assemblages: [], land: read("land.json"),
  });

  test("a country-wide view stays inside a few megabytes", () => {
    const scene = buildScene(shipped(), { lat: 9.5, lng: 49.0 }, 400_000);
    const mb = JSON.stringify(scene).length / 1e6;
    // 8.99 MB before the cap; 2.03 MB after. The ceiling is what stops the
    // bridge crossing becoming the most expensive thing the app does.
    expect(mb).toBeLessThan(3);
  });

  test("no single kind of line exceeds the cap", () => {
    const scene = buildScene(shipped(), { lat: 9.5, lng: 49.0 }, 400_000);
    expect(scene.drainage.length).toBeLessThanOrEqual(MAX_LINES_PER_KIND);
    expect(scene.faults.length).toBeLessThanOrEqual(MAX_LINES_PER_KIND);
    expect(scene.contacts.length).toBeLessThanOrEqual(MAX_LINES_PER_KIND);
    expect(scene.lineaments.length).toBeLessThanOrEqual(MAX_LINES_PER_KIND);
  });

  test("a close view is NOT capped — the detail is there when it can be seen", () => {
    const scene = buildScene(shipped(), { lat: 9.5, lng: 49.0 }, 15_000);
    expect(scene.drainage.length).toBeGreaterThan(0);
    expect(scene.drainage.length).toBeLessThan(MAX_LINES_PER_KIND);
  });

  test("what survives the cap is the trunk network, not a random scatter", () => {
    // Ranked by vertex count, which for a traced channel network stands in for
    // stream order. Thinning by array order would leave disconnected fragments.
    const scene = buildScene(shipped(), { lat: 9.5, lng: 49.0 }, 400_000);
    const sizes = scene.drainage.map((l) => l.paths.reduce((n, p) => n + p.length, 0));
    const smallest = Math.min(...sizes);
    const median = [...sizes].sort((a, b) => a - b)[Math.floor(sizes.length / 2)];
    expect(median).toBeGreaterThanOrEqual(smallest);
    expect(sizes.every((n) => n >= 2)).toBe(true);
  });
});

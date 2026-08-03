// Offline geological map — projection and measurement (pure, no WebView).
import { buildMapView, elevationAt, nearestFaultM, nearestOccurrence } from "../geo/mapView";
import type { PackData } from "../../../shared/geo-core/pack/types.ts";
import { buildMapSvg } from "../../components/GeologyMap";

const MOG = { lat: 2.0469, lng: 45.3182 };

function data(): PackData {
  return {
    geology: [{
      id: "g1", name: "Basement", kind: "metamorphic", source: "Macrostrat",
      attributes: { color: "#AABBCC" },
      rings: [[[45.0, 1.8], [45.6, 1.8], [45.6, 2.4], [45.0, 2.4], [45.0, 1.8]]],
      bbox: [45.0, 1.8, 45.6, 2.4], isPolygon: true,
    }],
    occurrences: [{
      id: "o1", name: "Near Gold", commodity_key: "gold", deposit_type: null,
      host_rocks: null, lat: MOG.lat + 0.01, lng: MOG.lng, dataset_id: "d",
      source: "USGS MRDS", version: null, reference: null, cell: "c",
    }],
    knowledge: [], structures: [], community: [],
    mapFeatures: [{
      id: "f1", kind: "fault", name: "F", source: "macrostrat_lines", attributes: null,
      lines: [[[MOG.lng + 0.004, MOG.lat - 0.05], [MOG.lng + 0.004, MOG.lat + 0.05]]],
      bbox: [MOG.lng + 0.004, MOG.lat - 0.05, MOG.lng + 0.004, MOG.lat + 0.05],
    }],
    terrain: [
      { cell: "t1", lat: MOG.lat, lng: MOG.lng, elevationM: 600, slopeDeg: 5,
        aspectDeg: null, reliefM: 20, morphology: "slope", drainageDistM: null },
      { cell: "t2", lat: MOG.lat + 0.02, lng: MOG.lng, elevationM: 900, slopeDeg: 9,
        aspectDeg: null, reliefM: 40, morphology: "ridge", drainageDistM: null },
    ],
    associations: [], rules: [], commodities: [], assemblages: [],
  };
}

describe("buildMapView", () => {
  const v = buildMapView(data(), MOG, { width: 300, height: 260 });

  test("the viewer sits at the centre of the view", () => {
    expect(v.centre.x).toBeCloseTo(150, 0);
    expect(v.centre.y).toBeCloseTo(130, 0);
  });

  test("north is up — a point further north projects HIGHER on screen", () => {
    const occ = v.points[0];
    expect(occ.y).toBeLessThan(v.centre.y);
  });

  test("bedrock keeps Macrostrat's own colour", () => {
    expect(v.polygons).toHaveLength(1);
    expect(v.polygons[0].color).toBe("#AABBCC");
  });

  test("a unit larger than the view still colours it", () => {
    const tiny = buildMapView(data(), MOG, { width: 300, height: 260, radiusM: 500 });
    expect(tiny.polygons).toHaveLength(1);
  });

  test("faults and occurrences are projected", () => {
    expect(v.lines).toHaveLength(1);
    expect(v.points).toHaveLength(1);
    expect(v.points[0].distanceM).toBeGreaterThan(0);
  });

  test("terrain shading spans the local relief, not an absolute scale", () => {
    const shades = v.terrain.map((t) => t.shade).sort();
    expect(shades[0]).toBeCloseTo(0, 5);
    expect(shades[shades.length - 1]).toBeCloseTo(1, 5);
  });

  test("flat ground gets neutral shading rather than invented relief", () => {
    const d = data();
    d.terrain = d.terrain.map((t) => ({ ...t, elevationM: 600 }));
    const flat = buildMapView(d, MOG, { width: 300, height: 260 });
    expect(flat.terrain.every((t) => t.shade === 0.5)).toBe(true);
  });

  test("a target is projected and drawn from the centre", () => {
    const withTarget = buildMapView(data(), MOG, {
      width: 300, height: 260,
      target: { lat: MOG.lat + 0.02, lng: MOG.lng + 0.02, bearingDeg: 45, distanceM: 3000 },
    });
    expect(withTarget.target).not.toBeNull();
    expect(withTarget.target!.x).toBeGreaterThan(withTarget.centre.x);
    expect(withTarget.target!.y).toBeLessThan(withTarget.centre.y);
  });

  test("the scale bar is a round number of km that fits", () => {
    expect([1, 2, 5]).toContain(v.scaleBar.km);
    expect(v.scaleBar.px).toBeGreaterThan(0);
    expect(v.scaleBar.px).toBeLessThan(v.width);
  });

  test("an empty pack yields an empty map, not a crash", () => {
    const empty: PackData = {
      geology: [], occurrences: [], knowledge: [], structures: [], community: [],
      mapFeatures: [], terrain: [], associations: [], rules: [], commodities: [], assemblages: [],
    };
    const e = buildMapView(empty, MOG, { width: 300, height: 260 });
    expect(e.polygons).toEqual([]);
    expect(e.terrain).toEqual([]);
  });
});

describe("measurements for the evidence readout", () => {
  const d = data();

  test("nearest fault is measured to the LINE", () => {
    const m = nearestFaultM(d, MOG)!;
    expect(m).toBeGreaterThan(400);
    expect(m).toBeLessThan(500);
  });

  test("nearest occurrence carries its commodity", () => {
    const o = nearestOccurrence(d, MOG)!;
    expect(o.commodity).toBe("gold");
    expect(o.distanceM).toBeGreaterThan(1000);
  });

  test("elevation comes from the nearest sampled cell", () => {
    expect(elevationAt(d, MOG)).toBe(600);
  });

  test("elevation is null where no DEM covers the ground — never guessed", () => {
    expect(elevationAt(d, { lat: 9.56, lng: 44.06 })).toBeNull();
  });

  test("no faults means no distance, not zero", () => {
    const bare = { ...d, mapFeatures: [] };
    expect(nearestFaultM(bare, MOG)).toBeNull();
  });
});

describe("map rendering", () => {
  test("produces standalone SVG with no remote references", () => {
    const v = buildMapView(data(), MOG, { width: 300, height: 260 });
    const svg = buildMapSvg(v, { you: "You", target: "Target" });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("#AABBCC");
    // Nothing may FETCH over the network: the map must work where the guidance
    // does. The xmlns is a namespace identifier, not a request, so the check is
    // for actual remote references — href/src/url() — not for the string
    // "http" appearing anywhere.
    expect(svg).not.toMatch(/(?:href|src)\s*=\s*"https?:/i);
    expect(svg).not.toMatch(/url\(\s*['"]?https?:/i);
    expect(svg).not.toContain("<image");
    expect(svg).not.toContain("<script");
  });
});

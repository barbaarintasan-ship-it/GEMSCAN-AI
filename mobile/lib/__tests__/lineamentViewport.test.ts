// Viewport-first lineament selection — regression + REAL bundled-pack integration.
//
// Context: all 5,960 DEM lineaments are 2-vertex segments, so the old
// largestFirst(500) degenerated to "first 500 in pack order" (all southern) and
// the north/NE rendered none. buildScene() now selects lineaments from the
// actual VIEWPORT: all of them when <=500, else a deterministic, spatially even,
// input-order-independent subsample. Faults/contacts/drainage are untouched.
//
// Locations below are chosen from the pack's own mineral-occurrence coordinates
// spread across North/NE, Central and South — this proves the fix works map-wide,
// not only at the two points where the bug was first measured.
import { buildScene, spatialSubsample } from "../geo/mapScene";
import type { PackData, PackMapFeature } from "../../../shared/geo-core/pack/types.ts";

const M_PER_DEG_LAT = 111_195;
function boxAround(c: { lat: number; lng: number }, rM: number): [number, number, number, number] {
  const dLat = rM / M_PER_DEG_LAT;
  const dLng = dLat / Math.max(0.1, Math.cos((c.lat * Math.PI) / 180));
  return [c.lng - dLng, c.lat - dLat, c.lng + dLng, c.lat + dLat];
}
// Accepts a PackMapFeature (geometry in `.lines`) OR a SceneLine (geometry in
// `.paths`), so it works on both pack input and buildScene output.
function centreOf(l: unknown): [number, number] {
  const geom = ((l as { paths?: [number, number][][] }).paths
    ?? (l as { lines?: [number, number][][] }).lines) as [number, number][][];
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const path of geom) for (const [lng, lat] of path) {
    if (lng < a) a = lng; if (lng > c) c = lng; if (lat < b) b = lat; if (lat > d) d = lat;
  }
  return [(a + c) / 2, (b + d) / 2];
}
const inBox = (p: [number, number], b: readonly number[]) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
function emptyPack(features: PackMapFeature[]): PackData {
  return { geology: [], occurrences: [], knowledge: [], structures: [], community: [],
    mapFeatures: features, terrain: [], associations: [], rules: [], commodities: [],
    assemblages: [], land: [] } as unknown as PackData;
}
function synthLineaments(prefix: string, box: number[], count: number): PackMapFeature[] {
  const out: PackMapFeature[] = []; const side = Math.ceil(Math.sqrt(count));
  for (let i = 0; i < count; i++) {
    const r = Math.floor(i / side), c = i % side;
    const lng = box[0] + ((box[2] - box[0]) * (c + 0.5)) / side, lat = box[1] + ((box[3] - box[1]) * (r + 0.5)) / side;
    out.push({ id: `${prefix}-${String(i).padStart(4, "0")}`, kind: "lineament", name: null, source: "t",
      attributes: null, lines: [[[lng, lat], [lng + 0.005, lat + 0.005]]], bbox: [lng, lat, lng + 0.005, lat + 0.005] } as unknown as PackMapFeature);
  }
  return out;
}
// SceneLine-shaped (geometry in `paths`) — for testing spatialSubsample directly.
function synthScene(prefix: string, box: number[], count: number) {
  return synthLineaments(prefix, box, count).map((f) => ({ id: f.id, kind: f.kind, name: f.name, paths: f.lines }));
}
const shuffle = <T,>(arr: T[], seed: number): T[] => {
  const a = arr.slice(); let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) { s = (1103515245 * s + 12345) >>> 0; const j = s % (i + 1); const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
};

// ───────────────────────── Synthetic regression ─────────────────────────
describe("spatialSubsample() — deterministic, order-independent, representative", () => {
  const SOM: [number, number, number, number] = [41, -1.4, 51.4, 11.9];
  test("<=max returns all; >max returns exactly max", () => {
    expect(spatialSubsample(synthScene("a", SOM, 300) as never, 500, SOM).length).toBe(300);
    expect(spatialSubsample(synthScene("b", SOM, 1800) as never, 500, SOM).length).toBe(500);
  });
  test("shuffle-invariant selected id-set (5 seeds)", () => {
    const lines = synthScene("c", SOM, 1800) as never[];
    const base = spatialSubsample(lines, 500, SOM).map((l: any) => l.id).sort();
    for (const seed of [1, 7, 42, 9999, 123456]) {
      const got = spatialSubsample(shuffle(lines, seed), 500, SOM).map((l: any) => l.id).sort();
      expect(got).toEqual(base);
    }
  });
  test("spatial fairness: 600 South + 600 North => both represented", () => {
    const lines = [...synthScene("S", [42, -1, 49, 4], 600), ...synthScene("N", [43, 8, 51, 11.8], 600)] as never[];
    const sel = spatialSubsample(lines, 500, SOM);
    const south = sel.filter((l: any) => centreOf(l)[1] < 5).length, north = sel.length - south;
    expect(south).toBeGreaterThanOrEqual(150); expect(north).toBeGreaterThanOrEqual(150);
  });
});

// ───────────────────────── buildScene viewport contract ─────────────────────────
describe("buildScene() viewport-first lineament selection", () => {
  const CENTRE = { lat: 9.5, lng: 49.08 };
  test("req1: viewport<=500 => all viewport lineaments drawn; req3: none outside viewport", () => {
    const vb = boxAround(CENTRE, 50_000);
    // 120 inside the viewport + 2000 outside (but inside the R*4 scene) -> all 120 kept, 0 outside.
    const inside = synthLineaments("in", vb, 120);
    const scene = boxAround(CENTRE, 200_000);
    const outside = synthLineaments("out", [scene[0], scene[1], vb[0], scene[3]], 2000); // west strip, outside vb
    const s = buildScene(emptyPack([...inside, ...outside]), CENTRE, 50_000, vb);
    const outsideSelected = s.lineaments.filter((l) => !inBox(centreOf(l as never), vb)).length;
    expect(s.lineaments.length).toBe(120);
    expect(outsideSelected).toBe(0);
  });
  test("req2: viewport>500 => exactly 500, all inside viewport", () => {
    const vb = boxAround(CENTRE, 50_000);
    const s = buildScene(emptyPack(synthLineaments("in", vb, 900)), CENTRE, 50_000, vb);
    expect(s.lineaments.length).toBe(500);
    expect(s.lineaments.every((l) => inBox(centreOf(l as never), vb))).toBe(true);
  });
  test("req6: selection follows the viewport on pan (N/E/S/W)", () => {
    const base = synthLineaments("grid", [46, 6, 52, 12], 4000); // dense NE-Somalia grid
    for (const shift of [{ lat: 0.4, lng: 0 }, { lat: -0.4, lng: 0 }, { lat: 0, lng: 0.4 }, { lat: 0, lng: -0.4 }]) {
      const c = { lat: CENTRE.lat + shift.lat, lng: CENTRE.lng + shift.lng };
      const vb = boxAround(c, 50_000);
      const s = buildScene(emptyPack(base), c, 50_000, vb);
      expect(s.lineaments.every((l) => inBox(centreOf(l as never), vb))).toBe(true); // only in-view
      expect(s.lineaments.length).toBeGreaterThan(0);                                 // and non-empty
    }
  });
  test("req7: faults/contacts/drainage still use largestFirst (unchanged)", () => {
    // 600 drainage with VARYING vertex counts; largestFirst keeps the longest 500.
    const drainage: PackMapFeature[] = [];
    for (let i = 0; i < 600; i++) {
      const verts: [number, number][] = [];
      const len = 2 + (i % 50); // 2..51 vertices
      for (let v = 0; v < len; v++) verts.push([49 + v * 0.001, 9.5 + i * 0.001]);
      drainage.push({ id: `d-${i}`, kind: "drainage", name: null, source: null, attributes: null,
        lines: [verts], bbox: [49, 9.5 + i * 0.001, 49 + len * 0.001, 9.5 + i * 0.001] } as unknown as PackMapFeature);
    }
    const s = buildScene(emptyPack(drainage), { lat: 9.8, lng: 49.0 }, 500_000, boxAround({ lat: 9.8, lng: 49.0 }, 500_000));
    expect(s.drainage.length).toBe(500);
    const keptMinVerts = Math.min(...s.drainage.map((l) => l.paths.reduce((n, p) => n + p.length, 0)));
    const droppedMaxVerts = Math.max(...drainage.filter((d) => !s.drainage.find((k) => k.id === d.id))
      .map((l) => l.lines.reduce((n, p) => n + p.length, 0)));
    expect(keptMinVerts).toBeGreaterThanOrEqual(droppedMaxVerts); // longest kept => largestFirst intact
  });
});

// ───────────────────────── REAL bundled-pack integration ─────────────────────────
describe("REAL bundled geo-pack (5,960 lineaments) — map-wide viewport selection", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rows = (require("../../assets/geo-pack/maplayers.json").rows) as PackMapFeature[];
  const pack = emptyPack(rows);
  const LOCATIONS = [
    { tag: "Qardho (NE, regression)", lat: 9.5, lng: 49.08 },
    { tag: "Elk Occ (North)", lat: 8.967, lng: 45.334 },
    { tag: "Hargeisa-Awareh (NW)", lat: 9.351, lng: 44.068 },
    { tag: "Girta Gabno (Central)", lat: 5.134, lng: 45.434 },
    { tag: "Bur Coreh (South)", lat: 1.951, lng: 43.434 },
    { tag: "Bur Irmogugi (South)", lat: 2.235, lng: 43.301 },
    { tag: "Mogadishu (control)", lat: 2.05, lng: 45.34 },
  ];
  const ZOOMS = [10_000, 50_000, 500_000];
  const lineaments = rows.filter((r) => r.kind === "lineament");

  test("every location x zoom: viewport<=500 draws all; >500 draws 500; none outside viewport", () => {
    console.log("\nlocation                         | zoom  | vpElig | selected | outside");
    for (const L of LOCATIONS) {
      for (const rM of ZOOMS) {
        const vb = boxAround(L, rM);
        const vpElig = lineaments.filter((l) => inBox(centreOf(l), vb)).length;
        const s = buildScene(pack, L, rM, vb);
        const selected = s.lineaments.length;
        const outside = s.lineaments.filter((l) => !inBox(centreOf(l as never), vb)).length;
        console.log(`${L.tag.padEnd(32)} | ${String(rM / 1000).padStart(3)}km | ${String(vpElig).padStart(6)} | ${String(selected).padStart(8)} | ${String(outside).padStart(7)}`);
        expect(outside).toBe(0);                                   // req3/req5: only in-view
        expect(selected).toBe(vpElig <= 500 ? vpElig : 500);       // req1/req2
      }
    }
  });

  test("performance: buildScene over the real pack (wide zoom, worst case)", () => {
    const L = { lat: 6.0, lng: 47.0 }, rM = 500_000, vb = boxAround(L, rM);
    const t0 = Date.now(); const s = buildScene(pack, L, rM, vb); const ms = Date.now() - t0;
    console.log(`\nbuildScene real pack (${rows.length} map features): ${ms}ms, lineaments selected=${s.lineaments.length}`);
    expect(s.lineaments.length).toBeLessThanOrEqual(500);
  });

  test("rendering path: SCENE.lineaments is populated (consumed by prepLines/drawLineSet, unchanged)", () => {
    const L = { lat: 9.5, lng: 49.08 }, rM = 50_000;
    const s = buildScene(pack, L, rM, boxAround(L, rM));
    expect(Array.isArray(s.lineaments)).toBe(true);
    expect(s.lineaments.length).toBeGreaterThan(0); // Qardho NE now has in-view lineaments (was 0)
  });
});

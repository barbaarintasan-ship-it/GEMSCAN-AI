// Land and sea — so the app can tell the difference.
//
//   deno run --allow-net --allow-write scripts/ingest-coastline.ts \
//     --out land.json [--west 37.5 --south -2.5 --east 51.5 --north 12.5]
//
// WHY THIS EXISTS
// ---------------
// The pack had no coastline, so the app could not distinguish sea from land.
// Both rendered as the same black background on the map, and a target drawn
// 175 km offshore looked exactly like one on unmapped ground. A geologist
// asked, reasonably, whether the app had just sent them into the Gulf of Aden,
// and nothing in the data could answer.
//
// Macrostrat's geology is not a substitute. It maps land, but it does not map
// ALL land: 37% of the pack's own extent falls outside every mapped unit, and
// that 37% is a mixture of ocean and genuinely unmapped ground. Treating
// "no geology" as "sea" would have marked real Somali terrain as water.
//
// SOURCE (published, cited, not derived):
//   Natural Earth 1:10m physical land polygons. Public domain, no attribution
//   required — the standard answer when a project needs land from sea and
//   nothing more. Not a survey product and not used as one: it decides land or
//   sea, and nothing else reads it.
//
// Clipped to the coverage area and thinned, because the global file is 18 MB
// and the pack ships on a phone.
const SOURCE_URL =
  "https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/10m/physical/ne_10m_land.json";

function argOf(n: string): string | undefined {
  const i = Deno.args.indexOf(`--${n}`);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}

const OUT = argOf("out") ?? "land.json";
const BBOX: [number, number, number, number] = [
  Number(argOf("west") ?? 37.5),
  Number(argOf("south") ?? -2.5),
  Number(argOf("east") ?? 51.5),
  Number(argOf("north") ?? 12.5),
];
/**
 * Vertices kept per ring AFTER clipping.
 *
 * High, because this is a regional extract, not a world map: once the global
 * polygon has been cut down to the Horn there are only a few thousand vertices
 * left and they are all coastline someone might stand on.
 */
const MAX_RING_VERTICES = Number(argOf("maxVertices") ?? 20000);

type Coord = [number, number];
type Ring = Coord[];

console.log(`fetching ${SOURCE_URL.split("/").pop()}…`);
const res = await fetch(SOURCE_URL);
if (!res.ok) {
  console.error(`fetch failed: HTTP ${res.status}`);
  Deno.exit(2);
}
const fc = await res.json() as {
  features: Array<{ geometry: { type: string; coordinates: unknown } }>;
};
console.log(`${fc.features.length} land features worldwide`);

function bboxOf(ring: Ring): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [lng, lat] of ring) {
    if (lng < w) w = lng;
    if (lng > e) e = lng;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  return [w, s, e, n];
}

const overlaps = (b: [number, number, number, number]) =>
  !(b[2] < BBOX[0] || b[0] > BBOX[2] || b[3] < BBOX[1] || b[1] > BBOX[3]);

/**
 * Sutherland–Hodgman: clip a polygon to the rectangle.
 *
 * THIS IS THE POINT OF THE SCRIPT, and the first version skipped it. Natural
 * Earth's land layer is a handful of continent-sized rings; Africa arrives as
 * one polygon running from Siberia to the Cape. Keeping such a ring whole and
 * thinning it to fit left the ENTIRE Somali coastline described by fifteen
 * vertices — a land/sea test that happened to pass on points far inland and far
 * offshore, and would have been worthless anywhere near the shore.
 *
 * Clipping first, thinning second, keeps full resolution where it is needed and
 * discards every vertex in Siberia. The rectangle is convex, which is the one
 * condition this algorithm requires.
 */
function clipToBox(ring: Ring, box: [number, number, number, number]): Ring {
  const [w, s, e, n] = box;
  type Edge = { inside: (p: Coord) => boolean; cut: (a: Coord, b: Coord) => Coord };
  const lerp = (a: Coord, b: Coord, t: number): Coord =>
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

  const edges: Edge[] = [
    { inside: (p) => p[0] >= w, cut: (a, b) => lerp(a, b, (w - a[0]) / (b[0] - a[0])) },
    { inside: (p) => p[0] <= e, cut: (a, b) => lerp(a, b, (e - a[0]) / (b[0] - a[0])) },
    { inside: (p) => p[1] >= s, cut: (a, b) => lerp(a, b, (s - a[1]) / (b[1] - a[1])) },
    { inside: (p) => p[1] <= n, cut: (a, b) => lerp(a, b, (n - a[1]) / (b[1] - a[1])) },
  ];

  let out: Ring = ring;
  for (const edge of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      const curIn = edge.inside(cur);
      const prevIn = edge.inside(prev);
      if (curIn) {
        if (!prevIn) out.push(edge.cut(prev, cur));
        out.push(cur);
      } else if (prevIn) {
        out.push(edge.cut(prev, cur));
      }
    }
    if (out.length === 0) return [];
  }
  // Close it: the point-in-polygon test that decides land or sea reads every
  // ring as closed, and an open one answers at random near the seam.
  if (out.length > 0) {
    const f = out[0], l = out[out.length - 1];
    if (f[0] !== l[0] || f[1] !== l[1]) out.push([f[0], f[1]]);
  }
  return out;
}

function thin(ring: Ring, max: number): Ring {
  if (ring.length <= max) return ring;
  const step = Math.ceil(ring.length / max);
  const out: Ring = [];
  for (let i = 0; i < ring.length; i += step) out.push(ring[i]);
  const first = ring[0];
  const last = out[out.length - 1];
  if (last[0] !== first[0] || last[1] !== first[1]) out.push(first);
  return out;
}

const rings: Ring[] = [];

for (const f of fc.features) {
  const parts: Ring[][] = f.geometry.type === "Polygon"
    ? [f.geometry.coordinates as Ring[]]
    : (f.geometry.coordinates as Ring[][][]).flat().map((r) => [r as unknown as Ring]);

  for (const part of parts) {
    const outer = part[0];
    if (!Array.isArray(outer) || outer.length < 4) continue;
    if (!overlaps(bboxOf(outer))) continue;
    const clipped = clipToBox(outer, BBOX);
    if (clipped.length < 4) continue;
    rings.push(thin(clipped, MAX_RING_VERTICES));
  }
}

const vertices = rings.reduce((a, r) => a + r.length, 0);
console.log(`${rings.length} land rings intersect the area, ${vertices} vertices after thinning`);

if (rings.length === 0) {
  console.error("REFUSED: no land found in the area — the clip or the source is wrong.");
  Deno.exit(3);
}

// Same row shape as every other pack layer, so nothing downstream needs a
// special case for it.
const rows = rings.map((r, i) => ({
  bbox: bboxOf(r),
  // Distinctive on purpose. "land_0" collides with an Ionicons glyph name in
  // the shipped bundle ("flight-land" + "_0"), so a grep for it returns a false
  // positive — the same trap that once "proved" a button existed because
  // Ionicons embeds every glyph name in every build. This id cannot collide.
  id: `coastline_ne10m_${i}`,
  isPolygon: true,
  kind: "land",
  name: "land",
  rings: [r],
  source: "natural_earth_10m",
}));

await Deno.writeTextFile(OUT, JSON.stringify({ formatVersion: 1, kind: "land", rows }));
const bytes = (await Deno.stat(OUT)).size;
console.log(`wrote ${OUT} — ${(bytes / 1024).toFixed(0)} KB`);

// A land mask that says the whole region is land, or none of it, is worse than
// none: it would answer every "am I offshore?" question the same way.
const land = rows.filter((r) => r.bbox[3] > 5 && r.bbox[1] < 12).length;
console.log(`sanity: ${land} rings span the Somali latitudes`);

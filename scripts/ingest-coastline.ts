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
 * Vertices kept per ring.
 *
 * The coastline decides land or sea, and it is drawn as a background. A few
 * hundred metres of positional slack at the shore is irrelevant to both jobs;
 * shipping every vertex of a 1:10m global coastline is not.
 */
const MAX_RING_VERTICES = Number(argOf("maxVertices") ?? 1500);

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

function thin(ring: Ring, max: number): Ring {
  if (ring.length <= max) return ring;
  const step = Math.ceil(ring.length / max);
  const out: Ring = [];
  for (let i = 0; i < ring.length; i += step) out.push(ring[i]);
  // A coastline ring must stay closed, or the point-in-polygon test that
  // decides land or sea starts answering at random near the seam.
  const first = ring[0];
  const last = out[out.length - 1];
  if (last[0] !== first[0] || last[1] !== first[1]) out.push(first);
  return out;
}

// Outer rings only. Holes in Natural Earth's land layer are inland water, and
// the device's pointInRings treats every ring as an independent boundary — a
// hole fed to it would make a point inside a lake test as inside land twice.
// Colouring a lake as land is the conservative error for a mineral app.
const rings: Ring[] = [];
for (const f of fc.features) {
  const parts: Ring[][] = f.geometry.type === "Polygon"
    ? [f.geometry.coordinates as Ring[]]
    : (f.geometry.coordinates as Ring[][][]).flat().map((r) => [r as unknown as Ring]);

  for (const part of parts) {
    const outer = part[0];
    if (!Array.isArray(outer) || outer.length < 4) continue;
    if (!overlaps(bboxOf(outer))) continue;
    rings.push(thin(outer, MAX_RING_VERTICES));
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
  id: `land_${i}`,
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

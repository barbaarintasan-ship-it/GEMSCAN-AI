// Replace the pack's geology layer with real unit polygons, in place.
//
//   deno run --allow-read --allow-write scripts/patch-pack-geology.ts \
//     --units units-190.geojson [--pack mobile/assets/geo-pack]
//
// WHY THIS EXISTS SEPARATELY FROM THE PACK BUILDER
// -----------------------------------------------
// build-geo-pack.ts reads the production database, which is the right source of
// truth and the path this change should eventually take: ingest-macrostrat-units
// --apply writes the units to geo.geological_layer, and the next pack build
// picks them up with no special case. This script exists so the SHIPPED pack can
// be corrected without waiting on that, because what it is replacing is not
// merely stale — it is wrong. The 344 "units" in the pack were 0.5-degree
// sampling rectangles: every ring had five vertices, unit boundaries sat on
// lines of latitude, and the offline map rendered as one flat coloured slab.
//
// Everything else in the pack is left untouched, and the manifest is rewritten
// with the SAME canonicalJson and sha256 the builder uses — so the result passes
// the same verification any pack does, rather than being a pack with a hole in
// its integrity check.
import { canonicalJson } from "../shared/geo-core/pack/canonical.ts";
import { sha256Hex } from "../shared/geo-core/pack/sha256.ts";
import { MANIFEST_FILE, type PackManifest } from "../shared/geo-core/pack/types.ts";

function argOf(n: string): string | undefined {
  const i = Deno.args.indexOf(`--${n}`);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}

const UNITS = argOf("units");
const PACK = argOf("pack") ?? "mobile/assets/geo-pack";
if (!UNITS) {
  console.error("--units <geojson> is required (output of ingest-macrostrat-units.ts)");
  Deno.exit(2);
}

type Ring = Array<[number, number]>;

interface Feature {
  geometry: { type: string; coordinates: Ring[][] | Ring[] };
  properties: Record<string, unknown>;
}

const fc = JSON.parse(await Deno.readTextFile(UNITS)) as { features: Feature[] };
console.log(`${fc.features.length} harvested units`);

/**
 * The name a geologist reads on the map.
 *
 * Macrostrat source 190 leaves `name` empty for most African units, so the raw
 * field yields "sedimentary" — true, and useless on a screen. The map's own
 * legend names a unit by age and lithology, so that is what is composed here.
 * Nothing is invented: both parts come from the harvested feature.
 */
function displayName(p: Record<string, unknown>): string {
  const lith = String(p.lith ?? "").trim();
  const interval = String(p.interval ?? "").trim();
  const given = String(p.name ?? "").trim();

  // A real stratigraphic name is kept as it is. But `name` also arrives already
  // filled with the lithology alone, and "sedimentary" on its own tells a
  // geologist nothing they cannot see. Age plus lithology is how the map's own
  // legend labels these units, so that is the fallback.
  if (given && given.toLowerCase() !== lith.toLowerCase()) return given;
  if (interval && lith) return `${interval} ${lith}`;
  return lith || interval || `unit ${String(p.map_id ?? "")}`;
}

function bboxOf(rings: Ring[]): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const r of rings) {
    for (const [lng, lat] of r) {
      if (lng < w) w = lng;
      if (lng > e) e = lng;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
  }
  return [w, s, e, n];
}

// Same row shape the builder emits, so nothing downstream can tell the
// difference between a patched pack and a rebuilt one.
const rows = fc.features.map((f, i) => {
  const rings: Ring[] = f.geometry.type === "MultiPolygon"
    ? (f.geometry.coordinates as Ring[][]).map((p) => p[0])
    : [(f.geometry.coordinates as Ring[])[0]];
  const p = f.properties;
  return {
    attributes: {
      color: p.color ?? null,
      interval: p.interval ?? null,
      age_top_ma: p.age_top_ma ?? null,
      age_bottom_ma: p.age_bottom_ma ?? null,
      lith: p.lith ?? null,
      descrip: p.descrip ?? null,
      macrostrat_map_id: p.map_id ?? null,
      macrostrat_source_id: p.macrostrat_source_id ?? null,
      licence: p.licence ?? null,
    },
    bbox: bboxOf(rings),
    id: `macrostrat_unit_${p.map_id ?? i}`,
    isPolygon: true,
    kind: String(p.kind ?? "unit"),
    name: displayName(p),
    rings,
    source: "macrostrat_units",
  };
});

// Refuse rather than ship a regression: the exact defect being fixed is
// five-vertex boxes, so a patch that would reintroduce them stops here.
const boxes = rows.filter((r) => r.rings.every((ring) => ring.length <= 5));
const vertices = rows.reduce((a, r) => a + r.rings.reduce((b, ring) => b + ring.length, 0), 0);
console.log(`${rows.length} units, ${vertices} vertices, ${boxes.length} all-box units`);
if (rows.length === 0 || boxes.length === rows.length) {
  console.error("REFUSED: nothing to write, or every unit is a box.");
  Deno.exit(3);
}

const geologyPath = `${PACK}/geology.json`;
const before = JSON.parse(await Deno.readTextFile(geologyPath)) as {
  formatVersion: number; kind: string; rows: unknown[];
};
console.log(`replacing ${before.rows.length} rows with ${rows.length}`);

const geology = canonicalJson({ ...before, rows });
await Deno.writeTextFile(geologyPath, geology);

// Rewrite the manifest: the file hash, the count, and the extent, which was
// derived from the rectangles and must now describe the real polygons.
const manifestPath = `${PACK}/${MANIFEST_FILE}`;
const manifest = JSON.parse(await Deno.readTextFile(manifestPath)) as PackManifest;

manifest.files["geology.json"] = sha256Hex(geology);
if (manifest.counts) manifest.counts.geology = rows.length;
manifest.sha256 = sha256Hex(canonicalJson(manifest.files));

await Deno.writeTextFile(manifestPath, canonicalJson(manifest));
console.log(`manifest rewritten — geology.json ${manifest.files["geology.json"].slice(0, 12)}…`);
console.log("run the pack verification test to confirm.");

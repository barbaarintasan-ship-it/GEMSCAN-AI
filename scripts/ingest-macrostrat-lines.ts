// Ingest the OFFICIAL Macrostrat line layers — faults, contacts, lineaments.
//
//   deno run --allow-env --allow-net scripts/ingest-macrostrat-lines.ts [--apply]
//
// SOURCE (published, cited, not derived):
//   Macrostrat "lines" layer — the same features the Macrostrat map draws.
//   Underlying map: Thiéblemont, D. (ed.), 2016, New edition of the
//   1:10,000,000 Geological Map of Africa, CGMW-BRGM (Macrostrat source_id 190).
//   Licence: CC-BY 4.0.
//
// This replaces the contact derivation that was rejected. Those lines were
// computed from a 0.5-degree sampling grid and had no source; these are the
// cartographer's own lines, each carrying its Macrostrat line_id, type and
// description ("inferred fault", "contact", …) exactly as the map shows them.
//
// Transport: Macrostrat's v2 REST API exposes no lines route, but its map is
// drawn from vector tiles that do — tiles.macrostrat.org/carto/{z}/{x}/{y}.mvt
// carries a `lines` layer alongside `units`. Reading the tiles is reading the
// published map, not scraping a private endpoint.
//
// Tile clipping: a line crossing a tile edge arrives as several fragments.
// They are regrouped by line_id so one mapped fault becomes one feature, not
// nine, which keeps "distance to nearest fault" honest.
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import Pbf from "https://esm.sh/pbf@3.2.1";
import { VectorTile } from "https://esm.sh/@mapbox/vector-tile@1.3.1";

const DB = Deno.env.get("DATABASE_URL");
const APPLY = Deno.args.includes("--apply");
const Z = Number(argOf("z") ?? 8);

function argOf(n: string): string | undefined {
  const i = Deno.args.indexOf(`--${n}`);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}

const SOURCE_KEY = "macrostrat_lines";
const SOURCE_URL = "https://macrostrat.org";
const LICENCE = "CC-BY 4.0";
const TITLE = "Macrostrat geological map lines (CGMW-BRGM 1:10,000,000 Africa)";
// Coverage: the whole Somali-inhabited Horn — Somalia, the Somali Region of
// Ethiopia (Ogaden), and North Eastern Kenya (Garissa, Wajir, Mandera).
// Geology does not stop at a border, and neither does a traverse.
const BBOX: [number, number, number, number] = [
  Number(argOf("west") ?? 37.5),
  Number(argOf("south") ?? -2.5),
  Number(argOf("east") ?? 51.5),
  Number(argOf("north") ?? 12.5),
];

// Zoom 8 is the carto tileset's maximum for this source: z=9 returns 404 for
// every tile. Anything above 8 silently yields an EMPTY pack, so it is pinned.
// ── Tile range covering the area ────────────────────────────────────────────
const lngToX = (lng: number, z: number) => Math.floor(((lng + 180) / 360) * 2 ** z);
const latToY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

const x0 = lngToX(BBOX[0], Z), x1 = lngToX(BBOX[2], Z);
const y0 = latToY(BBOX[3], Z), y1 = latToY(BBOX[1], Z);
const tiles: [number, number][] = [];
for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tiles.push([x, y]);
console.log(`zoom ${Z}: x ${x0}..${x1}, y ${y0}..${y1} — ${tiles.length} tiles`);

// ── Fetch + decode ──────────────────────────────────────────────────────────
interface LineProps {
  line_id?: number; source_id?: number; type?: string;
  descrip?: string; name?: string; direction?: string;
}
type Coord = [number, number];
const fragments = new Map<number, { props: LineProps; parts: Coord[][] }>();

let fetched = 0, empty = 0;
for (const [x, y] of tiles) {
  let buf: Uint8Array;
  try {
    const res = await fetch(`https://tiles.macrostrat.org/carto/${Z}/${x}/${y}.mvt`);
    if (!res.ok) { empty++; continue; }
    buf = new Uint8Array(await res.arrayBuffer());
  } catch { empty++; continue; }
  fetched++;
  if (buf.length === 0) { empty++; continue; }

  const tile = new VectorTile(new Pbf(buf));
  const layer = tile.layers["lines"];
  if (!layer) continue;

  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    // toGeoJSON does the tile-local -> lng/lat projection, so no hand-rolled
    // Mercator maths and no chance of an off-by-one tile origin.
    const gj = f.toGeoJSON(x, y, Z) as {
      geometry: { type: string; coordinates: unknown };
      properties: LineProps;
    };
    const props = gj.properties;
    const id = Number(props.line_id ?? -1);
    if (id < 0) continue;

    const parts: Coord[][] =
      gj.geometry.type === "LineString"
        ? [gj.geometry.coordinates as Coord[]]
        : (gj.geometry.coordinates as Coord[][]);

    const entry = fragments.get(id) ?? { props, parts: [] };
    entry.parts.push(...parts);
    fragments.set(id, entry);
  }
  if (fetched % 25 === 0) console.log(`  ${fetched}/${tiles.length} tiles, ${fragments.size} lines so far`);
}
console.log(`fetched ${fetched} tiles (${empty} empty/failed)`);

// ── Survey ──────────────────────────────────────────────────────────────────
const byType = new Map<string, number>();
const byDescrip = new Map<string, number>();
for (const { props } of fragments.values()) {
  const t = (props.type ?? "unspecified").toLowerCase();
  byType.set(t, (byType.get(t) ?? 0) + 1);
  const d = props.descrip || "(none)";
  byDescrip.set(d, (byDescrip.get(d) ?? 0) + 1);
}
console.log(`\n${fragments.size} distinct mapped lines`);
console.log("by type:");
for (const [k, n] of [...byType].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);
console.log("by description:");
for (const [k, n] of [...byDescrip].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${String(n).padStart(5)}  ${k}`);
}

// Only within the target area — tiles overhang the bbox at their edges.
const inArea = [...fragments.entries()].filter(([, v]) =>
  v.parts.some((p) => p.some(([lng, lat]) =>
    lng >= BBOX[0] && lng <= BBOX[2] && lat >= BBOX[1] && lat <= BBOX[3]))
);
console.log(`\n${inArea.length} lines intersect the coverage area`);

if (!APPLY) {
  console.log("\ndry run — pass --apply to write geo.geological_layer");
  Deno.exit(0);
}
if (!DB) { console.error("DATABASE_URL is required to apply"); Deno.exit(2); }

// ── Write ───────────────────────────────────────────────────────────────────
const c = new Client(DB);
await c.connect();

await c.queryObject(
  `insert into geo.dataset_registry (source_key, title, category, version, license, source_url, crs, coverage_note, record_count, is_current, metadata)
   values ($1, $2, 'structure', $3, $4, $5, 'EPSG:4326', $6, $7, true, $8::jsonb)
   on conflict do nothing`,
  [SOURCE_KEY, TITLE, "2026.08", LICENCE, SOURCE_URL,
   `Somalia + Somali Region (Ethiopia) + North Eastern Kenya; Macrostrat carto tiles at zoom ${Z}`, inArea.length,
   JSON.stringify({
     macrostrat_source_id: 190,
     underlying_map: "Thiéblemont, D. (ed.), 2016, New edition of the 1:10,000,000 Geological Map of Africa, CGMW-BRGM",
     attribution_required: true,
     types: [...byType.keys()],
   })],
);
console.log(`\ndataset registered — ${LICENCE}`);

await c.queryArray(`delete from geo.geological_layer where source = $1`, [SOURCE_KEY]);

let written = 0;
for (const [id, v] of inArea) {
  const kind = (v.props.type ?? "").toLowerCase().trim() || "other";
  const geojson = v.parts.length === 1
    ? { type: "LineString", coordinates: v.parts[0] }
    : { type: "MultiLineString", coordinates: v.parts };
  await c.queryObject(
    `insert into geo.geological_layer (name, kind, geom, source, attributes)
     values ($1, $2, extensions.st_geomfromgeojson($3), $4, $5::jsonb)`,
    [
      v.props.name?.trim() || v.props.descrip?.trim() || `${kind} ${id}`,
      kind,
      JSON.stringify(geojson),
      SOURCE_KEY,
      JSON.stringify({
        line_id: id,
        macrostrat_source_id: v.props.source_id ?? 190,
        descrip: v.props.descrip ?? null,
        direction: v.props.direction || null,
        licence: LICENCE,
        fragments: v.parts.length,
      }),
    ],
  );
  written++;
}
console.log(`wrote ${written} lines`);

const check = await c.queryObject<{ kind: string; gt: string; n: bigint }>(`
  select kind, extensions.geometrytype(geom) as gt, count(*)::bigint as n
  from geo.geological_layer group by 1,2 order by 3 desc
`);
console.log("\ngeo.geological_layer now holds:");
for (const r of check.rows) console.log(`  ${String(r.kind).padEnd(26)} ${String(r.gt).padEnd(18)} ${r.n}`);

await c.end();

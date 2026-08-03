// Ingest the OFFICIAL Macrostrat map UNITS — real bedrock polygons.
//
//   deno run --allow-env --allow-net --allow-write scripts/ingest-macrostrat-units.ts \
//     [--step 0.1] [--out units.geojson] [--apply]
//
// WHY THIS EXISTS
// ---------------
// geo.geological_layer previously held 344 "units" that were not units at all:
// a 0.5-degree sampling grid, each cell stored as its own ST_MakeEnvelope
// rectangle carrying the rock type found at the cell centre. Every ring had
// exactly five vertices. That is a raster masquerading as geology. It made the
// offline map a flat coloured slab, put unit boundaries on lines of latitude
// that do not exist in the ground, and reported "no mapped geology here" for
// points that Macrostrat maps perfectly well — the cell centre had been sea, or
// the rectangle had simply not been sampled.
//
// This replaces those rectangles with the cartographer's own polygons.
//
// SOURCE (published, cited, not derived):
//   Macrostrat /api/v2/geologic_units/map?...&format=geojson_bare, which returns
//   the map unit polygon at a point with its full geometry.
//   Preferred map: Thiéblemont, D. (ed.), 2016, New edition of the 1:10,000,000
//   Geological Map of Africa, CGMW-BRGM — Macrostrat source_id 190. That is the
//   same map scripts/ingest-macrostrat-lines.ts took the faults from, so units
//   and structures come from one cartography and a fault that bounds a unit
//   actually lies on its edge.
//   Licence: CC-BY 4.0.
//
// WHY NOT VECTOR TILES
// --------------------
// tiles.macrostrat.org/carto stops at zoom 8 (z9+ returns empty) and clips every
// polygon to the tile square. At z8 the tile over Bosaso contains one unit with
// five vertices — the tile boundary, not the geological one. Tiles are right for
// lines, which are short and rarely fill a tile; they are wrong for units.
//
// HARVEST STRATEGY
// ----------------
// The API is a POINT query but returns the WHOLE polygon, so a unit only has to
// be asked for once. The grid is walked in order and any point already inside an
// already-collected polygon is skipped without a request. Requests therefore
// scale with the number of distinct units, not with the number of grid points —
// a 0.1-degree grid over the Horn is ~21,000 points but costs only a few hundred
// calls. The step still matters: it sets the smallest unit that can be found, so
// a unit narrower than the step may be missed. It is not a resolution limit on
// the polygons themselves, which arrive at full precision either way.
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";

const DB = Deno.env.get("DATABASE_URL");
const APPLY = Deno.args.includes("--apply");

function argOf(n: string): string | undefined {
  const i = Deno.args.indexOf(`--${n}`);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}

const STEP = Number(argOf("step") ?? 0.1);
const OUT = argOf("out") ?? "";
/** Macrostrat source_id to keep. 190 = CGMW Africa, the map the faults came from. */
const PREFER_SOURCE = Number(argOf("source") ?? 190);

const SOURCE_KEY = "macrostrat_units";
const LICENCE = "CC-BY 4.0";
const TITLE = "Macrostrat geological map units (CGMW-BRGM 1:10,000,000 Africa)";

// Same coverage as the faults: Somalia, the Somali Region of Ethiopia, and
// North Eastern Kenya.
const BBOX: [number, number, number, number] = [
  Number(argOf("west") ?? 37.5),
  Number(argOf("south") ?? -2.5),
  Number(argOf("east") ?? 51.5),
  Number(argOf("north") ?? 12.5),
];

type Coord = [number, number];
type Ring = Coord[];

interface UnitProps {
  map_id: number; source_id: number; name?: string; strat_name?: string;
  lith?: string; descrip?: string; color?: string;
  t_int_name?: string; b_int_name?: string; best_int_name?: string;
  t_age?: number; b_age?: number;
}

interface Unit {
  props: UnitProps;
  /** Outer rings only — holes are dropped, see below. */
  rings: Ring[];
  /**
   * One bbox PER RING, not one for the unit.
   *
   * These units are multipolygons whose parts can be a thousand kilometres
   * apart — a coastal strip and an inland outlier in the same feature. A single
   * unit-wide bbox then covers everything between them, the cheap rejection
   * never fires, and the coverage test degrades to a full even-odd sweep of
   * every vertex for every grid point. Per-ring boxes keep the rejection tight.
   */
  ringBoxes: Array<[number, number, number, number]>;
  bbox: [number, number, number, number];
}

// ── Geometry ────────────────────────────────────────────────────────────────

/**
 * Even-odd point-in-ring. Deliberately identical in behaviour to
 * shared/geo-core/geo/spatial.ts#pointInRings: the harvester's idea of "already
 * covered" must match the device's idea of "you are standing in this unit", or
 * the grid will skip ground the app then reports as unmapped.
 */
function pointInRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
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

function coveredBy(units: Iterable<Unit>, lng: number, lat: number): boolean {
  for (const u of units) {
    if (lng < u.bbox[0] || lng > u.bbox[2] || lat < u.bbox[1] || lat > u.bbox[3]) continue;
    for (let i = 0; i < u.rings.length; i++) {
      const b = u.ringBoxes[i];
      if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) continue;
      if (pointInRing(lng, lat, u.rings[i])) return true;
    }
  }
  return false;
}

// ── Fetch ───────────────────────────────────────────────────────────────────

const API = "https://macrostrat.org/api/v2/geologic_units/map";

async function unitsAt(lng: number, lat: number): Promise<Unit[]> {
  const url = `${API}?lat=${lat.toFixed(4)}&lng=${lng.toFixed(4)}&format=geojson_bare`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return [];
      const body = await res.json() as {
        features?: Array<{ geometry: { type: string; coordinates: unknown } | null; properties: UnitProps }>;
      };
      const out: Unit[] = [];
      for (const f of body.features ?? []) {
        if (!f.geometry) continue;
        // Rings: for a Polygon, coordinates[0] is the outer ring and the rest are
        // holes; for a MultiPolygon each part has that shape. Only outer rings are
        // kept. A hole would need even-odd counting across the whole part to be
        // read correctly, and the device's pointInRings treats every ring as an
        // independent boundary — feeding it holes would make a point inside a
        // hole test as inside the unit twice and cancel to "outside" only by
        // accident. Dropping holes is the conservative error: at worst a lake or
        // an inlier is coloured as its surrounding unit, which is visible on the
        // map and never invents a rock type where none is mapped.
        const parts: Coord[][][] = f.geometry.type === "Polygon"
          ? [f.geometry.coordinates as Coord[][]]
          : (f.geometry.coordinates as Coord[][][]);
        const rings = parts.map((p) => p[0]).filter((r) => Array.isArray(r) && r.length >= 4);
        if (rings.length === 0) continue;
        out.push({
          props: f.properties,
          rings,
          ringBoxes: rings.map((r) => bboxOf([r])),
          bbox: bboxOf(rings),
        });
      }
      return out;
    } catch {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  return [];
}

// ── Harvest ─────────────────────────────────────────────────────────────────

const kept = new Map<number, Unit>();   // map_id -> unit, preferred source only
const seenOther = new Map<number, number>(); // source_id -> count, for the survey
let requests = 0, skipped = 0, points = 0;

const cols = Math.floor((BBOX[2] - BBOX[0]) / STEP) + 1;
const rows = Math.floor((BBOX[3] - BBOX[1]) / STEP) + 1;
console.log(`grid ${cols} x ${rows} = ${cols * rows} points at ${STEP} deg over [${BBOX}]`);
console.log(`preferring Macrostrat source_id ${PREFER_SOURCE}\n`);

const started = Date.now();
for (let iy = 0; iy < rows; iy++) {
  const lat = BBOX[1] + iy * STEP;
  for (let ix = 0; ix < cols; ix++) {
    const lng = BBOX[0] + ix * STEP;
    points++;
    if (coveredBy(kept.values(), lng, lat)) { skipped++; continue; }

    requests++;
    const found = await unitsAt(lng, lat);
    for (const u of found) {
      const sid = Number(u.props.source_id);
      seenOther.set(sid, (seenOther.get(sid) ?? 0) + 1);
      if (sid !== PREFER_SOURCE) continue;
      const id = Number(u.props.map_id);
      if (!kept.has(id)) kept.set(id, u);
    }
  }
  const pct = (((iy + 1) / rows) * 100).toFixed(0);
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(
    `  row ${iy + 1}/${rows} (${pct}%) lat ${lat.toFixed(2)} — ` +
    `${kept.size} units, ${requests} requests, ${skipped} skipped, ${secs}s`,
  );
}

console.log(`\nvisited ${points} grid points`);
console.log(`  ${requests} API requests, ${skipped} skipped by coverage`);
console.log(`  ${kept.size} distinct units from source ${PREFER_SOURCE}`);
console.log("  sources encountered:");
for (const [sid, n] of [...seenOther].sort((a, b) => b[1] - a[1])) {
  console.log(`    source_id ${String(sid).padStart(4)}: ${n} hits${sid === PREFER_SOURCE ? "  <- kept" : ""}`);
}

// ── Verify before anything is written ───────────────────────────────────────
// The rectangles passed every structural check that existed and were still
// wrong, so the checks now include the thing that would have caught them.
const vertexCounts = [...kept.values()].map((u) => u.rings.reduce((a, r) => a + r.length, 0));
const rectangles = [...kept.values()].filter((u) => u.rings.every((r) => r.length <= 5));
const total = vertexCounts.reduce((a, b) => a + b, 0);
console.log(`\ngeometry: ${total} vertices total, ` +
  `median ${vertexCounts.sort((a, b) => a - b)[Math.floor(vertexCounts.length / 2)] ?? 0} per unit, ` +
  `max ${Math.max(0, ...vertexCounts)}`);
console.log(`  units whose every ring is a 4-5 point box: ${rectangles.length}`);
if (kept.size > 0 && rectangles.length === kept.size) {
  console.error("REFUSED: every unit is a box — this is the sampling-grid artifact again, not geology.");
  Deno.exit(3);
}

const withColour = [...kept.values()].filter((u) => typeof u.props.color === "string" && u.props.color).length;
console.log(`  units carrying a legend colour: ${withColour}/${kept.size}`);

// ── Emit ────────────────────────────────────────────────────────────────────

function nameOf(p: UnitProps): string {
  // Macrostrat source 190 leaves `name` empty for most African units, so the
  // raw field yields "sedimentary" — true, and useless to read on a screen.
  // The map's own legend names the unit by age and lithology, so that is what
  // is composed here. Nothing is invented: both parts come from the feature.
  const explicit = (p.name || p.strat_name || "").trim();
  if (explicit) return explicit;
  const lith = (p.lith || "").trim();
  const interval = (p.best_int_name || p.t_int_name || "").trim();
  if (interval && lith) return `${interval} ${lith}`;
  return lith || interval || `unit ${p.map_id}`;
}

function featureOf(u: Unit) {
  return {
    type: "Feature" as const,
    geometry: {
      type: "MultiPolygon" as const,
      // Each outer ring becomes its own single-ring polygon part. Holes were
      // already dropped, so this is exactly what was kept, stated plainly.
      coordinates: u.rings.map((r) => [r]),
    },
    properties: {
      name: nameOf(u.props),
      kind: (u.props.lith || "unit").toLowerCase().trim(),
      map_id: u.props.map_id,
      macrostrat_source_id: u.props.source_id,
      color: u.props.color ?? null,
      lith: u.props.lith ?? null,
      strat_name: u.props.strat_name || null,
      descrip: u.props.descrip || null,
      interval: u.props.best_int_name ?? u.props.t_int_name ?? null,
      age_top_ma: u.props.t_age ?? null,
      age_bottom_ma: u.props.b_age ?? null,
      licence: LICENCE,
    },
  };
}

if (OUT) {
  const fc = { type: "FeatureCollection", features: [...kept.values()].map(featureOf) };
  await Deno.writeTextFile(OUT, JSON.stringify(fc));
  console.log(`\nwrote ${OUT}`);
}

if (!APPLY) {
  console.log("\ndry run — pass --apply to write geo.geological_layer");
  Deno.exit(0);
}
if (!DB) { console.error("DATABASE_URL is required to apply"); Deno.exit(2); }

const c = new Client(DB);
await c.connect();

await c.queryObject(
  `insert into geo.dataset_registry (source_key, title, category, version, license, source_url, crs, coverage_note, record_count, is_current, metadata)
   values ($1, $2, 'geology', $3, $4, $5, 'EPSG:4326', $6, $7, true, $8::jsonb)
   on conflict do nothing`,
  [SOURCE_KEY, TITLE, "2026.08", LICENCE, "https://macrostrat.org",
   `Somalia + Somali Region (Ethiopia) + North Eastern Kenya; harvested at ${STEP} deg`, kept.size,
   JSON.stringify({
     macrostrat_source_id: PREFER_SOURCE,
     underlying_map: "Thiéblemont, D. (ed.), 2016, New edition of the 1:10,000,000 Geological Map of Africa, CGMW-BRGM",
     attribution_required: true,
     holes_dropped: true,
     replaces: "macrostrat_generalized (0.5-degree sampling rectangles)",
   })],
);

// The rectangles go in the same transaction-less pass, but only AFTER the new
// units verified above — losing bad geology is fine, losing all geology is not.
const old = await c.queryObject<{ n: bigint }>(
  `select count(*)::bigint as n from geo.geological_layer
   where source is distinct from 'macrostrat_lines' and extensions.geometrytype(geom) like '%POLYGON'`,
);
console.log(`\nremoving ${old.rows[0]?.n ?? 0} existing polygon rows (sampling rectangles)`);
await c.queryArray(
  `delete from geo.geological_layer
   where source is distinct from 'macrostrat_lines' and extensions.geometrytype(geom) like '%POLYGON'`,
);

let written = 0;
for (const u of kept.values()) {
  const f = featureOf(u);
  await c.queryObject(
    `insert into geo.geological_layer (name, kind, geom, source, attributes)
     values ($1, $2, extensions.st_geomfromgeojson($3), $4, $5::jsonb)`,
    [f.properties.name, f.properties.kind, JSON.stringify(f.geometry), SOURCE_KEY, JSON.stringify(f.properties)],
  );
  written++;
}
console.log(`wrote ${written} units`);

const check = await c.queryObject<{ source: string; gt: string; n: bigint }>(`
  select coalesce(source,'(none)') as source, extensions.geometrytype(geom) as gt, count(*)::bigint as n
  from geo.geological_layer group by 1,2 order by 3 desc
`);
console.log("\ngeo.geological_layer now holds:");
for (const r of check.rows) console.log(`  ${r.source.padEnd(22)} ${String(r.gt).padEnd(18)} ${r.n}`);

await c.end();

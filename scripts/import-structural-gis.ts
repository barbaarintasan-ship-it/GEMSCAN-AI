// Import REAL structural GIS into geo.structural_feature.
//
//   deno run --allow-env --allow-net --allow-read \
//     scripts/import-structural-gis.ts \
//     --file data/somalia_faults.geojson \
//     --layer faults \
//     --source usgs_geo7_2ag --version 1997.OFR97-470A \
//     --confidence medium \
//     [--apply]
//
// WHAT THIS DOES, AND WHAT IT REFUSES TO DO
// -----------------------------------------
// It ingests a GeoJSON FeatureCollection of LINE geometry (faults, lineaments,
// shear zones, contacts, fold axes) into the PostGIS table geo.structural_feature,
// registers the dataset's provenance, and flips geo.gis_layer_status for that
// layer from `no_source_available` to `loaded`.
//
// It NEVER fabricates geometry. Every feature written is a line that was present
// in the input file — a real, sourced dataset the operator supplied. There is no
// code path that invents a fault from adjacency, a DEM, or anything else. That is
// the whole point of the ingestion architecture (Invariant 4): the system becomes
// useful the moment REAL data is loaded, and says NO SOURCE AVAILABLE until then.
//
// SHAPEFILES: convert to GeoJSON first, which every GIS toolchain does losslessly:
//   ogr2ogr -f GeoJSON -t_srs EPSG:4326 out.geojson input.shp
//
// DEM-DERIVED LINEAMENTS are allowed ONLY with --confidence interpreted and a
// source key that names them as such (e.g. copernicus_dem_derived). They are
// stored, scored low, and NEVER presented as mapped faults. See docs/GIS_INGESTION.md.
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { parseArgs } from "https://deno.land/std@0.224.0/cli/parse_args.ts";

const LAYER_TO_TYPE: Record<string, string> = {
  faults: "fault",
  lineaments: "lineament",
  shear_zones: "shear_zone",
  fracture_zones: "fracture_zone",
  contacts: "contact",
  major_trends: "fold_axis",
};
const LINE_GEOMS = new Set(["LineString", "MultiLineString"]);
const CONFIDENCES = new Set(["high", "medium", "low", "interpreted"]);

interface GeoJsonFeature {
  type: "Feature";
  geometry: { type: string; coordinates: unknown } | null;
  properties: Record<string, unknown> | null;
}
interface GeoJsonFC { type: "FeatureCollection"; features: GeoJsonFeature[] }

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  Deno.exit(1);
}

const args = parseArgs(Deno.args, {
  string: ["file", "layer", "source", "version", "confidence"],
  boolean: ["apply"],
});

if (!args.file) die("--file <path.geojson> is required");
const layer = String(args.layer ?? "");
const targetType = LAYER_TO_TYPE[layer];
if (!targetType) die(`--layer must be one of: ${Object.keys(LAYER_TO_TYPE).join(", ")}`);
if (!args.source) die("--source <source_key> is required (provenance is mandatory)");
const confidence = args.confidence ? String(args.confidence) : null;
if (confidence && !CONFIDENCES.has(confidence)) {
  die(`--confidence must be one of: ${[...CONFIDENCES].join(", ")}`);
}
if (targetType === "lineament" && confidence !== "interpreted" &&
    /dem|copernicus|srtm|automated/i.test(String(args.source))) {
  die("DEM-derived lineaments must be imported with --confidence interpreted");
}

// ── Read + validate the file ────────────────────────────────────────────────
let fc: GeoJsonFC;
try {
  fc = JSON.parse(await Deno.readTextFile(args.file)) as GeoJsonFC;
} catch (e) {
  die(`could not read/parse ${args.file}: ${e instanceof Error ? e.message : e}`);
}
if (fc?.type !== "FeatureCollection" || !Array.isArray(fc.features)) {
  die("input must be a GeoJSON FeatureCollection");
}

const rows: Array<{ name: string | null; feature_type: string; trend: number | null; geojson: string }> = [];
const skipped: string[] = [];
for (const [i, f] of fc.features.entries()) {
  const g = f.geometry;
  if (!g || !LINE_GEOMS.has(g.type)) {
    skipped.push(`#${i}: geometry ${g?.type ?? "null"} is not a line — structural features are lines`);
    continue;
  }
  const p = f.properties ?? {};
  // A per-feature type may override the layer default (a mixed structural export),
  // but only within the allowed vocabulary.
  const ft = typeof p.feature_type === "string" && Object.values(LAYER_TO_TYPE).includes(p.feature_type)
    ? p.feature_type
    : targetType;
  const name = typeof p.name === "string" ? p.name
    : typeof p.NAME === "string" ? p.NAME : null;
  const trend = typeof p.trend_deg === "number" ? p.trend_deg
    : typeof p.strike === "number" ? p.strike : null;
  rows.push({ name, feature_type: ft, trend, geojson: JSON.stringify(g) });
}

console.log(`\nInput   : ${args.file}`);
console.log(`Layer   : ${layer} → feature_type ${targetType}`);
console.log(`Source  : ${args.source}${args.version ? ` (${args.version})` : ""}`);
console.log(`Conf.   : ${confidence ?? "(unset)"}`);
console.log(`Features: ${rows.length} line(s) to import, ${skipped.length} skipped`);
if (skipped.length) console.log(skipped.slice(0, 5).map((s) => `  - ${s}`).join("\n"));
if (rows.length === 0) die("nothing to import — no line geometry found");

if (!args.apply) {
  console.log(`\nDRY RUN. Re-run with --apply to write ${rows.length} features.\n`);
  Deno.exit(0);
}

// ── Apply, in one transaction ─────────────────────────────────────────────────
const DB = Deno.env.get("DATABASE_URL");
if (!DB) die("DATABASE_URL is required");
const client = new Client(DB);
await client.connect();
try {
  await client.queryArray("begin");

  // Dataset provenance: get-or-create by source_key.
  const ds = await client.queryObject<{ id: string }>(
    `insert into geo.dataset_registry (source_key, version)
     values ($1, $2)
     on conflict (source_key) do update set version = excluded.version
     returning id::text`,
    [args.source, args.version ?? "unversioned"],
  );
  const datasetId = ds.rows[0].id;

  let inserted = 0;
  for (const r of rows) {
    await client.queryArray(
      `insert into geo.structural_feature
         (feature_type, name, geom, attributes, dataset_id, source_key, confidence, trend_deg)
       values ($1, $2,
         extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON($3), 4326)::extensions.geography,
         '{}'::jsonb, $4, $5, $6, $7)`,
      [r.feature_type, r.name, r.geojson, datasetId, args.source, confidence, r.trend],
    );
    inserted++;
  }

  const count = await client.queryObject<{ n: number }>(
    `select count(*)::int as n from geo.structural_feature where dataset_id = $1`,
    [datasetId],
  );

  await client.queryArray(
    `update geo.gis_layer_status
        set status = 'loaded', source_key = $2, dataset_id = $3,
            feature_count = $4, updated_at = now(),
            notes = 'Loaded ' || $4 || ' feature(s) from ' || $2
      where layer_key = $1`,
    [layer, args.source, datasetId, count.rows[0].n],
  );

  await client.queryArray("commit");
  console.log(`\n✓ Imported ${inserted} ${targetType} feature(s). Layer '${layer}' → loaded.`);
  console.log(`  Rebuild the pack: deno run ... scripts/build-geo-pack.ts\n`);
} catch (e) {
  await client.queryArray("rollback").catch(() => {});
  die(`import failed (rolled back): ${e instanceof Error ? e.message : e}`);
} finally {
  await client.end();
}

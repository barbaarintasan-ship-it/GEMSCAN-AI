// Knowledge pack builder — geo.* → a versioned offline pack (Stage E1).
//
//   deno run --allow-env --allow-net --allow-write --allow-read \
//     scripts/build-geo-pack.ts --out mobile/assets/geo-pack --version 1.0.0
//
// Connects DIRECTLY to Postgres rather than going through PostgREST: the export
// needs ST_AsGeoJSON and whole-table reads, which the point-query RPCs in 0058
// cannot express. This is a build-time developer tool, never an app path, so it
// needs no migration and nothing to deploy.
//
// The server stays the source of truth; this only derives an artifact from it.
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { latLngToCell } from "https://esm.sh/h3-js@4.1.0";
import { buildPack } from "../shared/geo-core/pack/build.ts";
import { verifyPack, describeFailure } from "../shared/geo-core/pack/verify.ts";
import { H3_RESOLUTION } from "../supabase/functions/_shared/geocontext/h3.ts";
import type {
  PackAssemblageRule, PackAssociation, PackCommodityProfile, PackCommunityCell,
  PackData, PackDatasetRef, PackGeologyUnit, PackKnowledgeItem, PackKnowledgeRule,
  PackOccurrence, PackStructuralFeature, PolygonRings, Position,
} from "../shared/geo-core/pack/types.ts";

// ── CLI ─────────────────────────────────────────────────────────────────────
function arg(name: string, fallback?: string): string {
  const i = Deno.args.indexOf(`--${name}`);
  const v = i >= 0 ? Deno.args[i + 1] : undefined;
  if (v === undefined && fallback === undefined) {
    console.error(`missing required --${name}`);
    Deno.exit(2);
  }
  return v ?? fallback!;
}

const OUT_DIR = arg("out", "mobile/assets/geo-pack");
const PACK_VERSION = arg("version", "1.0.0");
const PACK_ID = arg("pack", "somalia");
const REGION = arg("region", "SO");
const ENGINE_VERSION = arg("engine", "1.0.0");
const DB_URL = Deno.env.get("DATABASE_URL");

if (!DB_URL) {
  console.error("DATABASE_URL is required (postgres connection string to the geo database)");
  Deno.exit(2);
}

// ── Geometry helpers ────────────────────────────────────────────────────────
type GeoJson =
  | { type: "Point"; coordinates: [number, number] }
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] }
  | { type: string; coordinates: unknown };

/** GeoJSON gives loose number[]; the pack stores fixed [lng, lat] pairs. */
const toRings = (raw: number[][][]): PolygonRings =>
  raw.map((ring) => ring.map((p) => [p[0], p[1]] as Position));

/** Polygon/MultiPolygon → flat ring list. Anything else has no rings, so a point never matches it. */
function ringsOf(g: GeoJson): { rings: PolygonRings; isPolygon: boolean } {
  if (g.type === "Polygon") return { rings: toRings(g.coordinates as number[][][]), isPolygon: true };
  if (g.type === "MultiPolygon") {
    return { rings: toRings((g.coordinates as number[][][][]).flat()), isPolygon: true };
  }
  // Mapped faults/lineaments are LineStrings. ST_Intersects(line, point) is
  // effectively never true for a GPS fix, so dropping their rings preserves
  // server behaviour rather than changing it.
  return { rings: [], isPolygon: false };
}

function bboxOfRings(rings: PolygonRings): [number, number, number, number] {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const ring of rings) {
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng;
      if (lat < minLat) minLat = lat;
      if (lng > maxLng) maxLng = lng;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return Number.isFinite(minLng) ? [minLng, minLat, maxLng, maxLat] : [0, 0, 0, 0];
}

const cellFor = (lat: number, lng: number): string => latLngToCell(lat, lng, H3_RESOLUTION);

// ── Extraction ──────────────────────────────────────────────────────────────
async function extract(client: Client): Promise<{ data: PackData; datasets: PackDatasetRef[] }> {
  const q = async <T>(sql: string): Promise<T[]> =>
    (await client.queryObject<T>(sql)).rows as T[];

  // Geology — mixed geometry; ST_AsGeoJSON keeps full precision.
  const geologyRows = await q<{
    id: string; name: string; kind: string; source: string | null;
    attributes: Record<string, unknown> | null; gj: string;
  }>(`
    select id::text, name, kind, source, attributes,
           extensions.st_asgeojson(geom) as gj
    from geo.geological_layer
  `);
  const geology: PackGeologyUnit[] = geologyRows.map((r) => {
    const { rings, isPolygon } = ringsOf(JSON.parse(r.gj) as GeoJson);
    return {
      id: r.id, name: r.name, kind: r.kind, source: r.source,
      attributes: r.attributes ?? null,
      rings, isPolygon, bbox: bboxOfRings(rings),
    };
  });

  // Occurrences — points.
  const occRows = await q<{
    id: string; name: string | null; commodity_key: string | null; deposit_type: string | null;
    host_rocks: string[] | null; lat: number; lng: number; dataset_id: string;
    source: string; version: string | null; reference: string | null;
  }>(`
    select o.id::text, o.name, o.commodity_key, o.deposit_type, o.host_rocks,
           extensions.st_y(o.geom) as lat, extensions.st_x(o.geom) as lng,
           o.dataset_id::text, d.source, d.version, o.reference
    from geo.mineral_occurrence o
    join geo.dataset_registry d on d.id = o.dataset_id
    where o.geom is not null
  `);
  const occurrences: PackOccurrence[] = occRows.map((r) => ({
    id: r.id, name: r.name, commodity_key: r.commodity_key, deposit_type: r.deposit_type,
    host_rocks: r.host_rocks ?? null, lat: Number(r.lat), lng: Number(r.lng),
    dataset_id: r.dataset_id, source: r.source, version: r.version, reference: r.reference,
    cell: cellFor(Number(r.lat), Number(r.lng)),
  }));

  // Knowledge — geometry may be a polygon; the centroid is used as its position.
  // ST_Distance on the server measures to the nearest edge, so for non-point
  // geometry this is an approximation. Recorded as an E3 divergence source.
  const knRows = await q<{
    id: string; kind: string; statement: string; commodity_key: string | null;
    host_rock_key: string | null; tier: string | null; page: number | null;
    lat: number; lng: number; source_title: string | null;
    dataset_id: string | null; dataset_source: string | null; dataset_version: string | null;
  }>(`
    select gk.id::text, gk.kind, gk.statement, gk.commodity_key, gk.host_rock_key,
           gk.tier, gk.page,
           extensions.st_y(extensions.st_centroid(gk.geom)) as lat,
           extensions.st_x(extensions.st_centroid(gk.geom)) as lng,
           ks.title as source_title,
           ks.dataset_id::text, d.source as dataset_source, d.version as dataset_version
    from geo.geological_knowledge gk
    join geo.knowledge_source ks on ks.id = gk.source_id
    left join geo.dataset_registry d on d.id = ks.dataset_id
    where gk.geom is not null
  `);
  const knowledge: PackKnowledgeItem[] = knRows.map((r) => ({
    id: r.id, kind: r.kind, statement: r.statement, commodity_key: r.commodity_key,
    host_rock_key: r.host_rock_key, tier: r.tier, page: r.page,
    lat: Number(r.lat), lng: Number(r.lng), source_title: r.source_title,
    dataset_id: r.dataset_id ?? "", dataset_source: r.dataset_source ?? "",
    dataset_version: r.dataset_version,
    cell: cellFor(Number(r.lat), Number(r.lng)),
  }));

  // Structural features — dormant until data is loaded, but exported when present.
  const stRows = await q<{
    id: string; feature_type: string; name: string | null;
    lat: number; lng: number; attributes: Record<string, unknown> | null;
  }>(`
    select id::text, feature_type, name,
           extensions.st_y(extensions.st_centroid(geom::extensions.geometry)) as lat,
           extensions.st_x(extensions.st_centroid(geom::extensions.geometry)) as lng,
           attributes
    from geo.structural_feature
  `);
  const structures: PackStructuralFeature[] = stRows.map((r) => ({
    id: r.id, feature_type: r.feature_type, name: r.name,
    lat: Number(r.lat), lng: Number(r.lng), attributes: r.attributes ?? null,
    cell: cellFor(Number(r.lat), Number(r.lng)),
  }));

  // Community — per-cell aggregates only. No sample rows, no user data.
  const cmRows = await q<{
    h3: string; lat: number; lng: number; sample_count: number; verified_count: number;
  }>(`
    select h3,
           extensions.st_y(extensions.st_centroid(geom)) as lat,
           extensions.st_x(extensions.st_centroid(geom)) as lng,
           sum(sample_count)::int as sample_count,
           sum(verified_count)::int as verified_count
    from geo.coverage_cell
    where geom is not null
    group by h3, geom
  `);
  const community: PackCommunityCell[] = cmRows.map((r) => ({
    cell: r.h3, lat: Number(r.lat), lng: Number(r.lng),
    verified_scans: Number(r.verified_count), sample_count: Number(r.sample_count),
  }));

  const associations = await q<PackAssociation>(`
    select c.code as commodity_code, h.code as host_rock_code, a.weight
    from geo.mineral_association a
    join geo.commodity c on c.id = a.commodity_id
    join geo.host_rock h on h.id = a.host_rock_id
    where a.host_rock_id is not null
  `);

  const rules = await q<PackKnowledgeRule>(`
    select id::text, antecedent_type, antecedent_key, commodity_code, expected_minerals,
           relationship, likelihood, requires_setting, weight
    from geo.geo_knowledge_rule
  `);

  const commodities = await q<PackCommodityProfile>(`
    select code, name, category, typical_host_rocks, associated_minerals, alteration_styles,
           deposit_models, tectonic_settings, exploration_indicators, industrial_uses,
           is_critical_mineral, strategic_importance, confidence_limitations
    from geo.commodity_profile
  `);

  const assemblages = await q<PackAssemblageRule>(`
    select id::text, minerals, interpretation, commodity_code, likelihood, relationship, weight
    from geo.mineral_assemblage_rule
  `);

  const datasets = await q<PackDatasetRef>(`
    select id::text as "datasetId", source, version from geo.dataset_registry
  `);

  return {
    data: {
      geology, occurrences, knowledge, structures, community,
      associations: associations.map((a) => ({ ...a, weight: a.weight == null ? null : Number(a.weight) })),
      rules: rules.map((r) => ({ ...r, weight: r.weight == null ? null : Number(r.weight) })),
      commodities,
      assemblages: assemblages.map((a) => ({ ...a, weight: a.weight == null ? null : Number(a.weight) })),
    },
    datasets,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────
const client = new Client(DB_URL);
await client.connect();
console.log("connected — extracting geo.*");

let extracted;
try {
  extracted = await extract(client);
} finally {
  await client.end();
}

const opts = {
  packId: PACK_ID,
  packVersion: PACK_VERSION,
  engineVersion: ENGINE_VERSION,
  region: REGION,
  h3Resolution: H3_RESOLUTION,
  builtAt: new Date().toISOString(),
  datasets: extracted.datasets,
};

const built = buildPack(extracted.data, opts);

// Determinism check on REAL data — E1's exit criterion, asserted at every build
// rather than only in unit tests. `builtAt` is pinned so only the data varies.
const rebuilt = buildPack(extracted.data, opts);
if (rebuilt.manifest.sha256 !== built.manifest.sha256) {
  console.error("BUILD IS NOT DETERMINISTIC — same input produced two different hashes. Refusing to write.");
  Deno.exit(1);
}

const verdict = verifyPack(built.files);
if (!verdict.ok) {
  console.error(`built pack failed its own verification: ${describeFailure(verdict.failure)}`);
  Deno.exit(1);
}

await Deno.mkdir(OUT_DIR, { recursive: true });
let totalBytes = 0;
for (const [name, content] of Object.entries(built.files)) {
  await Deno.writeTextFile(`${OUT_DIR}/${name}`, content);
  totalBytes += content.length;
}

console.log(`\npack ${built.manifest.packId} v${built.manifest.packVersion}`);
console.log(`  sha256   ${built.manifest.sha256}`);
console.log(`  engine   ${built.manifest.engineVersion}  (h3 res ${built.manifest.h3Resolution})`);
console.log(`  bbox     ${JSON.stringify(built.manifest.bbox)}`);
console.log(`  size     ${(totalBytes / 1024).toFixed(1)} KB across ${Object.keys(built.files).length} files`);
for (const [k, v] of Object.entries(built.manifest.counts)) console.log(`    ${k.padEnd(14)}${v}`);
console.log(`\nwritten to ${OUT_DIR}`);

// Ingest active faults from the GEM Global Active Faults Database.
//
//   deno run --allow-env --allow-net --allow-read scripts/ingest-gem-faults.ts --apply
//
// SOURCE (authoritative, cited, not derived):
//   GEM Global Active Faults Database — GEM Foundation
//   https://github.com/GEMScienceTools/gem-global-active-faults
//   Licence: CC-BY-SA-4.0
//
// This is the opposite of the contact derivation that was rejected: those lines
// were computed from a grid and had no source. These are mapped faults from a
// published, peer-reviewed compilation, each carrying its originating catalogue.
//
// LICENCE NOTE — needs an owner decision before this ships:
//   CC-BY-SA-4.0 is SHARE-ALIKE. Attribution is mandatory and any adapted
//   version of the DATA must be released under the same licence. Bundling it in
//   the app is distribution of the data. It does not make the app's source code
//   share-alike, but it does mean the fault layer must carry attribution
//   in-product and cannot be relicensed. See scripts/README or ask before
//   shipping to a paying customer.
//
// It ingests FAULTS ONLY. GEM publishes no lineaments, and none are invented
// here — a lineament without a source is exactly the fabrication the contact
// derivation was rejected for.
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";

const DB = Deno.env.get("DATABASE_URL");
if (!DB) { console.error("DATABASE_URL is required"); Deno.exit(2); }
const APPLY = Deno.args.includes("--apply");
const FILE = argOf("file") ?? "C:/Users/awmus/AppData/Local/Temp/geodump/gem_faults.geojson";

function argOf(n: string): string | undefined {
  const i = Deno.args.indexOf(`--${n}`);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}

const SOURCE_KEY = "gem_active_faults";
const SOURCE_URL = "https://github.com/GEMScienceTools/gem-global-active-faults";
const LICENCE = "CC-BY-SA-4.0";
const TITLE = "GEM Global Active Faults Database";
// Somalia + a margin, so a fault that crosses the border is kept whole.
const BBOX: [number, number, number, number] = [40.0, -2.5, 52.0, 13.0];

interface Feature {
  type: string;
  geometry: { type: string; coordinates: unknown };
  properties: Record<string, unknown>;
}

const raw = JSON.parse(await Deno.readTextFile(FILE)) as { features: Feature[] };
console.log(`${raw.features.length} faults in the global database`);

function bboxOf(g: Feature["geometry"]): [number, number, number, number] {
  const xs: number[] = [], ys: number[] = [];
  const walk = (c: unknown): void => {
    const a = c as number[];
    if (typeof a[0] === "number") { xs.push(a[0]); ys.push(a[1]); return; }
    for (const x of c as unknown[]) walk(x);
  };
  walk(g.coordinates);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

const inArea = raw.features.filter((f) => {
  if (!/LineString/i.test(f.geometry.type)) return false; // faults are lines
  const b = bboxOf(f.geometry);
  return !(b[2] < BBOX[0] || b[0] > BBOX[2] || b[3] < BBOX[1] || b[1] > BBOX[3]);
});
console.log(`  ${inArea.length} intersect the Somalia region`);

const byCatalog = new Map<string, number>();
const bySlip = new Map<string, number>();
for (const f of inArea) {
  const c = String(f.properties.catalog_name ?? "unknown");
  const s = String(f.properties.slip_type ?? "unspecified");
  byCatalog.set(c, (byCatalog.get(c) ?? 0) + 1);
  bySlip.set(s, (bySlip.get(s) ?? 0) + 1);
}
console.log("  by source catalogue:");
for (const [k, n] of byCatalog) console.log(`    ${String(n).padStart(4)}  ${k}`);
console.log("  by slip type (this is what makes a fault an exploration signal):");
for (const [k, n] of bySlip) console.log(`    ${String(n).padStart(4)}  ${k}`);

if (!APPLY) {
  console.log("\ndry run — pass --apply to write geo.geological_layer + dataset_registry");
  Deno.exit(0);
}

const c = new Client(DB);
await c.connect();

// Provenance first: a fault row without a registered dataset cannot be traced
// back to its licence, and the pack carries dataset refs into the app.
await c.queryObject(
  `insert into geo.dataset_registry (source_key, title, category, version, license, source_url, crs, coverage_note, record_count, is_current, metadata)
   values ($1, $2, 'structure', $3, $4, $5, 'EPSG:4326', $6, $7, true, $8::jsonb)
   on conflict do nothing`,
  [SOURCE_KEY, TITLE, "2026.08", LICENCE, SOURCE_URL,
   "Somalia region subset of the global harmonised database", inArea.length,
   JSON.stringify({ attribution_required: true, share_alike: true, catalogs: [...byCatalog.keys()] })],
);
const ds = await c.queryObject<{ id: string }>(
  `select id::text from geo.dataset_registry where source_key = $1 limit 1`, [SOURCE_KEY]);
console.log(`\ndataset registered: ${ds.rows[0]?.id ?? "(none)"} — ${LICENCE}`);

console.log("writing faults…");
await c.queryArray(`delete from geo.geological_layer where source = $1`, [SOURCE_KEY]);

// ONSHORE ONLY.
//
// GEM's global set mixes continental faults with PLATE BOUNDARIES from Bird
// (2003). For Somalia that is 48 features — spreading ridges and transforms
// under the Gulf of Aden and the Owen Fracture Zone — and every one of them
// lies offshore. They are real and correctly sourced, but they are not
// exploration targets: a geologist cannot walk to a mid-ocean ridge, and
// surfacing one as "fault 12 km east" would be true and useless at once.
//
// A fault is kept only if it crosses mapped land. That is a property of the
// data, checked here, not a judgement about which catalogue is better.

let written = 0;
let offshore = 0;
for (const f of inArea) {
  const p = f.properties;
  const name = (p.name as string) || (p.fault_name as string) || null;

  const land = await c.queryObject<{ ok: boolean }>(
    `select exists (
       select 1 from geo.geological_layer g
       where extensions.geometrytype(g.geom) like '%POLYGON%'
         and extensions.st_intersects(extensions.st_geomfromgeojson($1), g.geom)
     ) as ok`,
    [JSON.stringify(f.geometry)],
  );
  if (!land.rows[0].ok) { offshore++; continue; }

  await c.queryObject(
    `insert into geo.geological_layer (name, kind, geom, source, attributes)
     values ($1, 'fault', extensions.st_geomfromgeojson($2), $3, $4::jsonb)`,
    [
      name ?? `Active fault (${p.slip_type ?? "unspecified"})`,
      JSON.stringify(f.geometry),
      SOURCE_KEY,
      JSON.stringify({
        slip_type: p.slip_type ?? null,
        catalog_name: p.catalog_name ?? null,
        catalog_id: p.catalog_id ?? null,
        licence: LICENCE,
        source_url: SOURCE_URL,
      }),
    ],
  );
  written++;
}
console.log(`  wrote ${written} onshore faults`);
console.log(`  skipped ${offshore} offshore plate-boundary features (not walkable ground)`);

const check = await c.queryObject<{ kind: string; gt: string; n: bigint }>(`
  select kind, extensions.geometrytype(geom) as gt, count(*)::bigint as n
  from geo.geological_layer group by 1,2 order by 3 desc
`);
console.log("\ngeo.geological_layer now holds:");
for (const r of check.rows) console.log(`  ${String(r.kind).padEnd(22)} ${String(r.gt).padEnd(16)} ${r.n}`);

await c.end();

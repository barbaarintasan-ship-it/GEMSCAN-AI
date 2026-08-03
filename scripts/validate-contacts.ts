// Topology + geometry validation for derived geological contacts.
//
//   deno run --allow-env --allow-net scripts/validate-contacts.ts
//
// A contact derived from polygon adjacency is only real if the polygons are
// real geological outlines. If they are sampling artifacts — grid tiles, buffered
// points, bounding boxes — then their shared edges are artifacts too, and every
// "contact" is a line drawn by the data pipeline rather than by geology.
//
// This script refuses to take that on trust. It is the gate the contact
// derivation must pass before anything it produces reaches a geologist.
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";

const DB = Deno.env.get("DATABASE_URL");
if (!DB) { console.error("DATABASE_URL is required"); Deno.exit(2); }

const c = new Client(DB);
await c.connect();

let fatal = 0;
const check = (ok: boolean, label: string, detail = "", isFatal = false) => {
  if (!ok && isFatal) fatal++;
  console.log(`${ok ? "PASS" : isFatal ? "FAIL" : "WARN"}  ${label}${detail ? " — " + detail : ""}`);
};

console.log("=== 1. POLYGON VALIDITY ===");
const invalid = await c.queryObject<{ n: bigint }>(`
  select count(*)::bigint as n from geo.geological_layer
  where extensions.geometrytype(geom) like '%POLYGON%'
    and not extensions.st_isvalid(geom)
`);
check(Number(invalid.rows[0].n) === 0, "all polygons are OGC-valid",
  `${invalid.rows[0].n} invalid`, true);

console.log("\n=== 2. ARE THESE REAL OUTLINES, OR SAMPLING ARTIFACTS? ===");
// A real geological outline is an irregular polygon. A rectangle with exactly
// 5 vertices, axis-aligned, is a bounding box or a grid tile.
const shape = await c.queryObject<{ total: bigint; rect: bigint }>(`
  select
    count(*)::bigint as total,
    count(*) filter (
      where extensions.st_npoints(geom) = 5
        and extensions.st_equals(geom, extensions.st_envelope(geom))
    )::bigint as rect
  from geo.geological_layer
  where extensions.geometrytype(geom) like '%POLYGON%'
`);
const total = Number(shape.rows[0].total);
const rect = Number(shape.rows[0].rect);
check(rect === 0, "polygons are irregular outlines, not rectangles",
  `${rect}/${total} are axis-aligned rectangles`, true);

// A regular grid betrays itself: every tile the same size, on a round spacing.
const grid = await c.queryObject<{ w: number; h: number; n: bigint }>(`
  select
    round((extensions.st_xmax(geom) - extensions.st_xmin(geom))::numeric, 4)::float8 as w,
    round((extensions.st_ymax(geom) - extensions.st_ymin(geom))::numeric, 4)::float8 as h,
    count(*)::bigint as n
  from geo.geological_layer
  where extensions.geometrytype(geom) like '%POLYGON%'
  group by 1, 2 order by 3 desc limit 5
`);
console.log("      polygon bbox sizes (degrees):");
for (const r of grid.rows) console.log(`        ${r.w} x ${r.h}  ->  ${r.n} polygons`);
check(grid.rows.length > 3, "polygon sizes vary (not one uniform tile size)",
  `${grid.rows.length} distinct sizes`, true);

console.log("\n=== 3. ADJACENCY QUALITY ===");
const overlaps = await c.queryObject<{ n: bigint }>(`
  select count(*)::bigint as n
  from geo.geological_layer a join geo.geological_layer b on a.id < b.id
  where extensions.geometrytype(a.geom) like '%POLYGON%'
    and extensions.geometrytype(b.geom) like '%POLYGON%'
    and extensions.st_overlaps(a.geom, b.geom)
`);
check(Number(overlaps.rows[0].n) === 0, "no polygon pair overlaps in area (pure adjacency)",
  `${overlaps.rows[0].n} overlapping pairs`);

console.log("\n=== 4. DO DERIVED CONTACTS FOLLOW A GRID? ===");
// A geological contact wanders. A grid line sits exactly on a round coordinate.
const derived = await c.queryObject<{ n: bigint }>(`
  select count(*)::bigint as n from geo.geological_layer
  where kind = 'contact' and source = 'derived:unit-adjacency'
`);
const nDerived = Number(derived.rows[0].n);
console.log(`      ${nDerived} derived contacts present`);

if (nDerived > 0) {
  const axis = await c.queryObject<{ n: bigint; onGrid: bigint }>(`
    with lines as (
      select geom,
        extensions.st_xmax(geom) - extensions.st_xmin(geom) as dx,
        extensions.st_ymax(geom) - extensions.st_ymin(geom) as dy
      from geo.geological_layer
      where kind = 'contact' and source = 'derived:unit-adjacency'
    )
    select count(*)::bigint as n,
      count(*) filter (
        where (dx < 1e-9 and (extensions.st_xmin(geom) * 4) = round((extensions.st_xmin(geom) * 4)::numeric)::float8)
           or (dy < 1e-9 and (extensions.st_ymin(geom) * 4) = round((extensions.st_ymin(geom) * 4)::numeric)::float8)
      )::bigint as "onGrid"
    from lines
  `);
  const onGrid = Number(axis.rows[0].onGrid);
  check(onGrid === 0, "contacts do not lie on a regular coordinate grid",
    `${onGrid}/${nDerived} sit exactly on 0.25-degree lines`, true);

  const sameKind = await c.queryObject<{ n: bigint }>(`
    select count(*)::bigint as n from geo.geological_layer
    where kind = 'contact' and source = 'derived:unit-adjacency'
      and attributes->'unit_a'->>'kind' = attributes->'unit_b'->>'kind'
  `);
  check(Number(sameKind.rows[0].n) === 0,
    "no contact separates two units of the SAME lithology",
    `${sameKind.rows[0].n} do`, true);
}

console.log("\n=== VERDICT ===");
if (fatal === 0) {
  console.log("Contacts are supportable: the polygons are real outlines and the");
  console.log("derived boundaries are not grid artifacts.");
} else {
  console.log(`${fatal} FATAL check(s) failed.`);
  console.log("These polygons cannot support contact derivation. Any 'contact'");
  console.log("computed from their adjacency is a line drawn by the data pipeline,");
  console.log("not by geology, and must NOT ship — it would be fabricated geology");
  console.log("presented to a geologist as a target (Invariant 4).");
}

await c.end();
Deno.exit(fatal === 0 ? 0 : 1);

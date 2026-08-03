// Derive geological contacts from mapped unit adjacency.
//
//   deno run --allow-env --allow-net scripts/derive-geological-contacts.ts [--apply]
//
// !! DO NOT RUN AGAINST THE CURRENT DATASET !!
//
// This works only where the polygons are REAL geological outlines. Somalia's
// Macrostrat load (migration 0072) is not: it uses ST_MakeEnvelope(xmin, ymin,
// xmax, ymax), so all 344 'polygons' are 0.5-degree axis-aligned RECTANGLES —
// a grid sampling of the map, not its boundaries.
//
// Run against that, this produced 165 'contacts', every one of which sat
// exactly on a 0.25-degree coordinate line, and six of which separated two
// units of the SAME lithology. They were grid lines drawn by the data
// pipeline, not geology. They were deleted, not shipped.
//
// scripts/validate-contacts.ts is the gate: run it FIRST, and only derive when
// it passes. This script stays because the derivation itself is sound — a
// contact IS a unit boundary — and becomes usable the moment a real vector
// geological map is loaded.
//
// A geological contact IS the boundary between two different rock units. That
// boundary is already implicit in the Macrostrat polygons, so contacts can be
// computed from data we hold rather than sourced externally — and a contact is
// a first-class exploration target (§7.7): it is where units meet, and where
// fluids often moved.
//
// This is DERIVATION, not invention. Every contact produced is the shared edge
// of two named units, and records which two, so the provenance survives into
// the pack.
//
// It deliberately does NOT produce faults or lineaments. Those are not implied
// by polygon adjacency — a fault is a break in the rock, which a unit boundary
// may or may not be — and there is no fault dataset loaded. Inventing them from
// adjacency would fabricate geology (Invariant 4).
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";

const DB = Deno.env.get("DATABASE_URL");
if (!DB) {
  console.error("DATABASE_URL is required");
  Deno.exit(2);
}
const APPLY = Deno.args.includes("--apply");

const client = new Client(DB);
await client.connect();

// Shared boundary between two DIFFERENT units, as a line.
//
// ST_Intersection of two touching polygons yields their common edge. Filtering
// to line-like results drops the point-touches (two units meeting at a corner),
// which are not contacts in any useful sense. The 500 m minimum drops slivers
// that are digitising noise rather than mapped geology.
const DERIVE_SQL = `
  with pairs as (
    select
      a.id as a_id, b.id as b_id,
      a.name as a_name, b.name as b_name,
      a.kind as a_kind, b.kind as b_kind,
      extensions.st_intersection(a.geom, b.geom) as shared
    from geo.geological_layer a
    join geo.geological_layer b
      on a.id < b.id
     and extensions.st_intersects(a.geom, b.geom)
    where a.name is distinct from b.name
  )
  select
    a_id::text, b_id::text, a_name, b_name, a_kind, b_kind,
    extensions.st_astext(line) as wkt,
    extensions.st_length(line::extensions.geography) as length_m
  from (
    select a_id, b_id, a_name, b_name, a_kind, b_kind,
           extensions.st_collectionextract(shared, 2) as line
    from pairs
  ) t
  where line is not null
    and not extensions.st_isempty(line)
    and extensions.st_length(line::extensions.geography) >= 500
  order by length_m desc
`;

console.log("deriving contacts from unit adjacency…");
const { rows } = await client.queryObject<{
  a_id: string; b_id: string; a_name: string; b_name: string;
  a_kind: string; b_kind: string; wkt: string; length_m: number;
}>(DERIVE_SQL);

console.log(`  ${rows.length} contacts found`);
if (rows.length > 0) {
  const total = rows.reduce((a, r) => a + Number(r.length_m), 0);
  console.log(`  total length ${(total / 1000).toFixed(0)} km`);
  console.log(`  longest      ${(Number(rows[0].length_m) / 1000).toFixed(1)} km — ${rows[0].a_name} / ${rows[0].b_name}`);
  const pairKinds = new Map<string, number>();
  for (const r of rows) {
    const k = [r.a_kind, r.b_kind].sort().join(" | ");
    pairKinds.set(k, (pairKinds.get(k) ?? 0) + 1);
  }
  console.log("  by unit pair:");
  for (const [k, n] of [...pairKinds.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8)) {
    console.log(`    ${String(n).padStart(5)}  ${k}`);
  }
}

if (!APPLY) {
  console.log("\ndry run — pass --apply to write them into geo.geological_layer");
  await client.end();
  Deno.exit(0);
}

// Contacts live in geological_layer alongside the polygons, with kind='contact'
// so the pack builder's existing mapKindOf() picks them up as line features.
// Re-runnable: previously derived contacts are replaced, never duplicated.
console.log("\nwriting contacts…");
await client.queryArray(
  `delete from geo.geological_layer where kind = 'contact' and source = 'derived:unit-adjacency'`,
);

let written = 0;
for (const r of rows) {
  await client.queryObject(
    `insert into geo.geological_layer (name, kind, geom, source, attributes)
     values ($1, 'contact', extensions.st_geomfromtext($2, 4326), 'derived:unit-adjacency', $3::jsonb)`,
    [
      `${r.a_name} / ${r.b_name}`,
      r.wkt,
      JSON.stringify({
        derived_from: "polygon adjacency",
        unit_a: { id: r.a_id, name: r.a_name, kind: r.a_kind },
        unit_b: { id: r.b_id, name: r.b_name, kind: r.b_kind },
        length_m: Math.round(Number(r.length_m)),
      }),
    ],
  );
  written++;
}

console.log(`  wrote ${written} contacts`);
const check = await client.queryObject<{ n: bigint }>(
  `select count(*)::bigint as n from geo.geological_layer where kind = 'contact'`,
);
console.log(`  geo.geological_layer now holds ${check.rows[0].n} contact lines`);

await client.end();

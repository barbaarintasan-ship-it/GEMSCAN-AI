// Terrain ingestion — SRTM 30 m → geo.terrain_cell (Architecture v1.1 §7.7).
//
//   deno run --allow-env --allow-net scripts/build-terrain.ts --apply
//
// Populating this table is what switches the TerrainProvider from dormant to
// live; no application code changes. Elevation is a MEASUREMENT of ground
// shape, which is in scope — unlike spectral imagery interpretation, which
// stays excluded (§14.1).
//
// Scope: terrain is sampled around KNOWN OCCURRENCES rather than across the
// whole country. Somalia at H3 res 7 is ~123,500 cells; with a 5-point stencil
// that is ~617,000 elevation lookups, far beyond any free API's daily budget.
// Exploration happens near known mineralisation, so the k-ring around each MRDS
// site is where terrain actually changes a recommendation. Cells outside that
// simply have no terrain, and the provider says nothing rather than guessing.
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { cellToLatLng, gridDisk, latLngToCell } from "https://esm.sh/h3-js@4.1.0";
import { H3_RESOLUTION } from "../shared/geo-core/geo/h3.ts";

const DB = Deno.env.get("DATABASE_URL");
if (!DB) {
  console.error("DATABASE_URL is required");
  Deno.exit(2);
}
const APPLY = Deno.args.includes("--apply");
const RINGS = Number(argOf("rings") ?? 2);
const SPACING_M = Number(argOf("spacing") ?? 500);
const DEM = "srtm30m";
const API = `https://api.opentopodata.org/v1/${DEM}`;
const BATCH = 100;          // OpenTopoData's documented per-request maximum
const THROTTLE_MS = 1100;   // its documented rate limit is 1 call/second

function argOf(name: string): string | undefined {
  const i = Deno.args.indexOf(`--${name}`);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}

// ── Target cells ────────────────────────────────────────────────────────────
const client = new Client(DB);
await client.connect();

const occ = await client.queryObject<{ lat: number; lng: number }>(`
  select extensions.st_y(geom) as lat, extensions.st_x(geom) as lng
  from geo.mineral_occurrence where geom is not null
`);
console.log(`${occ.rows.length} occurrences → sampling their ${RINGS}-ring neighbourhoods`);

const cells = new Set<string>();
for (const o of occ.rows) {
  for (const c of gridDisk(latLngToCell(Number(o.lat), Number(o.lng), H3_RESOLUTION), RINGS)) {
    cells.add(c);
  }
}
const targets = [...cells].sort();
console.log(`  ${targets.length} unique cells at H3 resolution ${H3_RESOLUTION}`);

// ── Sampling stencil ────────────────────────────────────────────────────────
// Centre plus four cardinal neighbours at `spacing`. Slope and aspect need real
// elevation DIFFERENCES over a known distance; sampling only cell centres
// (~2.6 km apart at res 7) would smooth real terrain into nothing.
const M_PER_DEG_LAT = 111_195;
function stencil(lat: number, lng: number): { lat: number; lng: number }[] {
  const dLat = SPACING_M / M_PER_DEG_LAT;
  const dLng = dLat / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  return [
    { lat, lng },                     // 0 centre
    { lat: lat + dLat, lng },         // 1 north
    { lat: lat - dLat, lng },         // 2 south
    { lat, lng: lng + dLng },         // 3 east
    { lat, lng: lng - dLng },         // 4 west
  ];
}

const points: { lat: number; lng: number }[] = [];
for (const c of targets) {
  const [lat, lng] = cellToLatLng(c);
  points.push(...stencil(lat, lng));
}
console.log(`  ${points.length} elevation samples (${BATCH} per request, ~${Math.ceil(points.length / BATCH)} requests)`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Fetch ───────────────────────────────────────────────────────────────────
const elevations: (number | null)[] = [];
const started = Date.now();
for (let i = 0; i < points.length; i += BATCH) {
  const chunk = points.slice(i, i + BATCH);
  const locs = chunk.map((p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join("|");
  let ok = false;
  for (let attempt = 0; attempt < 3 && !ok; attempt++) {
    try {
      const res = await fetch(`${API}?locations=${encodeURIComponent(locs)}`);
      if (res.status === 429) { await sleep(5_000); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as { results: { elevation: number | null }[] };
      for (const r of body.results) elevations.push(r.elevation);
      ok = true;
    } catch (e) {
      if (attempt === 2) {
        console.error(`  batch at ${i} failed: ${(e as Error).message}`);
        for (let k = 0; k < chunk.length; k++) elevations.push(null);
        ok = true;
      } else {
        await sleep(2_000);
      }
    }
  }
  const done = Math.min(i + BATCH, points.length);
  if (done % 2000 === 0 || done === points.length) {
    const pct = ((done / points.length) * 100).toFixed(0);
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    console.log(`  ${pct}% (${done}/${points.length}) after ${secs}s`);
  }
  await sleep(THROTTLE_MS);
}

// ── Derive ──────────────────────────────────────────────────────────────────
/** Standard finite-difference slope/aspect over the 5-point stencil. */
function derive(z: (number | null)[], spacing: number) {
  const [c, n, s, e, w] = z;
  if (c == null || n == null || s == null || e == null || w == null) return null;

  const dzdy = (n - s) / (2 * spacing);
  const dzdx = (e - w) / (2 * spacing);
  const slopeDeg = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;

  let aspectDeg: number | null = null;
  if (Math.hypot(dzdx, dzdy) > 1e-9) {
    // Compass bearing of the downslope direction.
    aspectDeg = ((Math.atan2(-dzdx, -dzdy) * 180) / Math.PI + 360) % 360;
  }

  const all = [c, n, s, e, w];
  const reliefM = Math.max(...all) - Math.min(...all);

  // Curvature: the centre against the mean of its neighbours. Positive means it
  // stands above them (a ridge), negative means it sits below (a valley).
  const meanNeighbour = (n + s + e + w) / 4;
  const curvature = c - meanNeighbour;
  const CURV_M = 3; // below this the difference is DEM noise, not landform

  let morphology: "ridge" | "slope" | "valley" | "flat";
  if (curvature > CURV_M) morphology = "ridge";
  else if (curvature < -CURV_M) morphology = "valley";
  else if (slopeDeg >= 3) morphology = "slope";
  else morphology = "flat";

  return { elevationM: c, slopeDeg, aspectDeg, reliefM, morphology };
}

const derived: {
  cell: string; lat: number; lng: number;
  elevationM: number; slopeDeg: number; aspectDeg: number | null;
  reliefM: number; morphology: string;
}[] = [];

for (let i = 0; i < targets.length; i++) {
  const z = elevations.slice(i * 5, i * 5 + 5);
  const d = derive(z, SPACING_M);
  if (!d) continue; // a hole in the DEM (or a failed batch) yields no row, not a zero
  const [lat, lng] = cellToLatLng(targets[i]);
  derived.push({ cell: targets[i], lat, lng, ...d });
}

console.log(`\nderived terrain for ${derived.length}/${targets.length} cells`);
const byMorph = new Map<string, number>();
for (const d of derived) byMorph.set(d.morphology, (byMorph.get(d.morphology) ?? 0) + 1);
for (const [m, n] of [...byMorph].sort((a, b) => b[1] - a[1])) console.log(`  ${m.padEnd(8)} ${n}`);
if (derived.length) {
  const el = derived.map((d) => d.elevationM);
  const sl = derived.map((d) => d.slopeDeg);
  console.log(`  elevation ${Math.min(...el).toFixed(0)}–${Math.max(...el).toFixed(0)} m`);
  console.log(`  slope     ${Math.min(...sl).toFixed(1)}–${Math.max(...sl).toFixed(1)}°`);
}

if (!APPLY) {
  console.log("\ndry run — pass --apply to write geo.terrain_cell");
  await client.end();
  Deno.exit(0);
}

console.log("\nwriting geo.terrain_cell…");
await client.queryArray(`delete from geo.terrain_cell where dem_source = $1`, [DEM]);
for (const d of derived) {
  await client.queryObject(
    `insert into geo.terrain_cell
       (h3, resolution, geom, elevation_m, slope_deg, aspect_deg, relief_m,
        morphology, drainage_dist_m, dem_source, sample_spacing_m)
     values ($1, $2, extensions.st_setsrid(extensions.st_makepoint($3, $4), 4326),
             $5, $6, $7, $8, $9, null, $10, $11)
     on conflict (h3) do update set
       elevation_m = excluded.elevation_m, slope_deg = excluded.slope_deg,
       aspect_deg = excluded.aspect_deg, relief_m = excluded.relief_m,
       morphology = excluded.morphology, dem_source = excluded.dem_source,
       sample_spacing_m = excluded.sample_spacing_m, ingested_at = now()`,
    [d.cell, H3_RESOLUTION, d.lng, d.lat, d.elevationM, d.slopeDeg,
     d.aspectDeg, d.reliefM, d.morphology, DEM, SPACING_M],
  );
}
const n = await client.queryObject<{ n: bigint }>(`select count(*)::bigint as n from geo.terrain_cell`);
console.log(`  geo.terrain_cell now holds ${n.rows[0].n} cells`);

// Drainage distance is deliberately left NULL. A drainage NETWORK requires flow
// accumulation over a continuous DEM grid, which point sampling cannot produce.
// Writing a guess here would fabricate geology; valley morphology already
// carries the part that is genuinely derivable from this data.
console.log("  drainage_dist_m left NULL — see the note in this script");

await client.end();

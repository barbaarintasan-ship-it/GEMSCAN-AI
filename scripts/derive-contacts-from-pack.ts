// SUPERSEDED — do not run. Use scripts/ingest-abbate-contacts.ts.
//
// This derived 154 contacts from the pack's 81 Macrostrat polygons. It worked and
// its output passed both grid gates, but the Geological Map of Somalia (Abbate et
// al., 1:1,500,000, digitized by UNESCO IHP-WINS) is a better source by an order of
// magnitude: 1,072 polygons and 2.1 million vertices carrying the actual Somali
// stratigraphy by name, against 81 polygons and 24,069 vertices from a global
// compilation. The Abbate script writes to the same `kind: "contact"` slot, so
// running this one would overwrite 1,538 mapped contacts with 154 coarser ones.
//
// Kept, not deleted: the shared-edge method and the two grid gates below are the
// same ones the Abbate script uses, and this is where they were worked out.
//
//   deno run --allow-read --allow-write scripts/derive-contacts-from-pack.ts \
//     [--pack mobile/assets/geo-pack] [--dry]
//
// A CORRECTION FIRST
// ------------------
// This project has twice recorded that contacts need data acquisition and cannot
// be derived. That was true of migration 0072, where Somalia's Macrostrat load
// used ST_MakeEnvelope and all 344 "polygons" were 0.5-degree rectangles: their
// shared edges were grid lines, the first derivation produced 165 of them sitting
// on 0.25-degree coordinates, and they were rightly deleted.
//
// The pack no longer contains that data. `patch-pack-geology.ts` replaced it with
// harvested Macrostrat unit outlines, and measured against what actually ships:
//
//     81 units, 18 to 2,679 vertices each, median 100
//     ZERO five-vertex rectangles
//     1 vertex of 24,069 on a 0.25-degree line — chance, not a grid
//     9,648 of 14,340 edges shared by two units
//
// Those shared edges are real. A geological contact IS the boundary between two
// different rock units, and here that boundary is an exact shared vertex sequence
// rather than something inferred. So this derives rather than acquires — and it
// re-runs the grid test on its own OUTPUT, because the failure it is guarding
// against is precisely a derivation that looks reasonable and is drawing the
// pipeline's own lines.
//
// WHAT IT WILL NOT DO
// -------------------
// It emits a contact only where two units of DIFFERENT lithology meet. A shared
// edge between two polygons of the same rock class is a map subdivision, not a
// geological boundary — six such lines were among the reasons the first attempt
// was discarded.
//
// It does not produce faults or lineaments. A fault is a break in the rock, which
// a unit boundary may or may not be, and inventing them from adjacency would
// fabricate geology (Invariant 4).
import { canonicalJson } from "../shared/geo-core/pack/canonical.ts";
import { sha256Hex } from "../shared/geo-core/pack/sha256.ts";
import {
  MANIFEST_FILE, type PackGeologyUnit, type PackManifest, type PackMapFeature,
} from "../shared/geo-core/pack/types.ts";

function argOf(n: string): string | undefined {
  const i = Deno.args.indexOf(`--${n}`);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}
const PACK = argOf("pack") ?? "mobile/assets/geo-pack";
const DRY = Deno.args.includes("--dry");

const ALGORITHM = "shared-edge adjacency between differing lithologies";
const ALGORITHM_VERSION = "1.0.0";
/** Coordinates are compared at this precision — about 10 cm. */
const DP = 6;

type Pt = [number, number];
const key = (p: Pt) => `${p[0].toFixed(DP)},${p[1].toFixed(DP)}`;

const geologyFile = JSON.parse(await Deno.readTextFile(`${PACK}/geology.json`)) as {
  rows: PackGeologyUnit[];
};
const units = geologyFile.rows.filter((u) => u.isPolygon && u.rings.length > 0);
console.log(`${units.length} mapped units`);

// ── GATE 1: are these real outlines? ────────────────────────────────────────
//
// Run BEFORE deriving anything. If the polygons are sampling artefacts then so is
// every edge they share, and the honest output is nothing at all.
const boxes = units.filter((u) => u.rings.every((r) => r.length <= 5)).length;
let vertices = 0, onGrid = 0;
for (const u of units) {
  for (const r of u.rings) {
    for (const [x, y] of r as Pt[]) {
      vertices++;
      // A 0.25-degree grid is what the old sampling rectangles sat on.
      if (Math.abs(x * 4 - Math.round(x * 4)) < 1e-6 || Math.abs(y * 4 - Math.round(y * 4)) < 1e-6) onGrid++;
    }
  }
}
const gridFraction = onGrid / Math.max(1, vertices);
console.log(`  ${vertices} vertices, ${boxes} five-vertex rectangles, ` +
  `${(gridFraction * 100).toFixed(2)}% on a 0.25-degree line`);

if (boxes > 0 || gridFraction > 0.05) {
  console.error(
    `REFUSED: these polygons look like sampling artefacts (${boxes} rectangles, ` +
    `${(gridFraction * 100).toFixed(1)}% grid-aligned vertices). Their shared edges would be ` +
    `grid lines, not geology. This is the exact failure that produced 165 false ` +
    `contacts once already.`,
  );
  Deno.exit(3);
}
console.log("  GATE 1 PASS — irregular outlines, not a grid");

// ── Shared edges between DIFFERENT lithologies ──────────────────────────────

interface Edge { a: Pt; b: Pt; units: string[] }
const edges = new Map<string, Edge>();
const byId = new Map(units.map((u) => [u.id, u]));

for (const u of units) {
  for (const r of u.rings) {
    const ring = r as Pt[];
    for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1], b = ring[i];
      const ka = key(a), kb = key(b);
      if (ka === kb) continue;
      const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      let e = edges.get(k);
      if (!e) { e = { a, b, units: [] }; edges.set(k, e); }
      if (!e.units.includes(u.id)) e.units.push(u.id);
    }
  }
}

const contactEdges: Array<{ a: Pt; b: Pt; pair: string; kinds: [string, string]; names: [string, string] }> = [];
let sameLithology = 0;
for (const e of edges.values()) {
  if (e.units.length !== 2) continue;
  const [u1, u2] = e.units.map((id) => byId.get(id)!);
  if (!u1 || !u2) continue;
  if (u1.kind === u2.kind) { sameLithology++; continue; }   // a map subdivision
  const pair = [u1.id, u2.id].sort().join("::");
  contactEdges.push({
    a: e.a, b: e.b, pair,
    kinds: [u1.kind, u2.kind],
    names: [u1.name, u2.name],
  });
}
console.log(`\n${edges.size} distinct edges`);
console.log(`  ${contactEdges.length} between DIFFERENT lithologies — candidate contacts`);
console.log(`  ${sameLithology} between the SAME lithology — map subdivisions, discarded`);

// ── Chain edges into polylines, within one unit pair ────────────────────────
//
// A contact is a line between two named units, so chaining never crosses from one
// pair to another: two different boundaries that happen to touch stay two
// features, each with its own provenance.
function chain(group: typeof contactEdges): Pt[][] {
  const adj = new Map<string, Pt[]>();
  const used = new Set<string>();
  const edgeKey = (a: Pt, b: Pt) => {
    const ka = key(a), kb = key(b);
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  for (const e of group) {
    for (const [from, to] of [[e.a, e.b], [e.b, e.a]] as Array<[Pt, Pt]>) {
      const k = key(from);
      let l = adj.get(k);
      if (!l) { l = []; adj.set(k, l); }
      l.push(to);
    }
  }

  const lines: Pt[][] = [];
  for (const e of group) {
    if (used.has(edgeKey(e.a, e.b))) continue;
    // Walk both ways from this edge until the chain ends or forks back.
    const walk = (start: Pt, next: Pt): Pt[] => {
      const path: Pt[] = [start, next];
      used.add(edgeKey(start, next));
      for (let guard = 0; guard < 100_000; guard++) {
        const here = path[path.length - 1];
        const options = (adj.get(key(here)) ?? []).filter((p) => !used.has(edgeKey(here, p)));
        if (options.length !== 1) break;   // an end, or a junction: stop cleanly
        used.add(edgeKey(here, options[0]));
        path.push(options[0]);
      }
      return path;
    };
    const forward = walk(e.a, e.b);
    const backward = walk(e.a, e.b === forward[1] ? e.a : e.b);   // no-op if consumed
    const line = backward.length > 2
      ? [...backward.slice(1).reverse(), ...forward]
      : forward;
    if (line.length >= 2) lines.push(line);
  }
  return lines;
}

const byPair = new Map<string, typeof contactEdges>();
for (const e of contactEdges) {
  let g = byPair.get(e.pair);
  if (!g) { g = []; byPair.set(e.pair, g); }
  g.push(e);
}

const features: PackMapFeature[] = [];
let seq = 0;
for (const [pair, group] of byPair) {
  for (const line of chain(group)) {
    const w = Math.min(...line.map((p) => p[0])), e = Math.max(...line.map((p) => p[0]));
    const s = Math.min(...line.map((p) => p[1])), n = Math.max(...line.map((p) => p[1]));
    features.push({
      id: `contact_macrostrat_${seq++}`,
      kind: "contact",
      name: `${group[0].names[0]} / ${group[0].names[1]}`,
      source: "derived:unit-adjacency",
      attributes: {
        algorithm: ALGORITHM,
        algorithm_version: ALGORITHM_VERSION,
        derived_from: "macrostrat_units",
        unit_pair: pair,
        lithologies: group[0].kinds,
        derived_at: new Date().toISOString(),
      },
      lines: [line],
      bbox: [w, s, e, n],
    });
  }
}

const contactVertices = features.reduce((a, f) => a + f.lines[0].length, 0);
console.log(`\n${features.length} contact features, ${contactVertices} vertices, ` +
  `${byPair.size} distinct unit pairs`);

// ── GATE 2: is the OUTPUT grid lines? ───────────────────────────────────────
//
// The input passed, but the derivation could still have concentrated on
// artefacts. Checked again on what actually came out, because the failure being
// guarded against looks reasonable right up until someone plots it.
let outVerts = 0, outGrid = 0;
for (const f of features) {
  for (const [x, y] of f.lines[0] as Pt[]) {
    outVerts++;
    if (Math.abs(x * 4 - Math.round(x * 4)) < 1e-6 || Math.abs(y * 4 - Math.round(y * 4)) < 1e-6) outGrid++;
  }
}
const outFraction = outGrid / Math.max(1, outVerts);
console.log(`  ${(outFraction * 100).toFixed(2)}% of contact vertices on a 0.25-degree line`);
if (outFraction > 0.05) {
  console.error(`REFUSED: ${(outFraction * 100).toFixed(1)}% of the derived contacts sit on grid ` +
    `coordinates. These are pipeline lines, not geology.`);
  Deno.exit(3);
}
console.log("  GATE 2 PASS — the output is not grid-aligned either");

if (features.length < 20) {
  console.error(`REFUSED: only ${features.length} contacts. 81 units sharing 9,648 edges should ` +
    `produce far more; this few means the chaining is wrong.`);
  Deno.exit(3);
}

if (DRY) {
  console.log("\n--dry: nothing written.");
  Deno.exit(0);
}

// ── Into the pack ───────────────────────────────────────────────────────────
const layersPath = `${PACK}/maplayers.json`;
const layers = JSON.parse(await Deno.readTextFile(layersPath)) as {
  formatVersion: number; kind: string; rows: PackMapFeature[];
};
const kept = layers.rows.filter((r) => r.kind !== "contact");
const rows = [...kept, ...features].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
console.log(`\nmaplayers: ${kept.length} existing + ${features.length} contacts = ${rows.length}`);

const body = canonicalJson({ ...layers, rows });
await Deno.writeTextFile(layersPath, body);

const manifestPath = `${PACK}/${MANIFEST_FILE}`;
const manifest = JSON.parse(await Deno.readTextFile(manifestPath)) as PackManifest;
manifest.files["maplayers.json"] = sha256Hex(body);
if (manifest.counts) manifest.counts.mapFeatures = rows.length;
manifest.sha256 = sha256Hex(canonicalJson(manifest.files));
await Deno.writeTextFile(manifestPath, canonicalJson(manifest));
console.log(`manifest rewritten — maplayers.json ${(body.length / 1e6).toFixed(1)} MB`);

console.log("\nCONTACTS ARE NOT SCORED YET. They are held in ROLES_NOT_SCORED until");
console.log("the leakage and usefulness gates run:");
console.log("  npx jest lib/__tests__/prospectivityBaseline.test.ts");

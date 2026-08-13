// Geological contacts from the Geological Map of Somalia, Abbate et al., 1:1,500,000.
//
//   deno run --allow-read --allow-write --allow-net scripts/ingest-abbate-contacts.ts \
//     [--shp <dir with Somalia_geology_1.5M.shp>] [--pack mobile/assets/geo-pack] [--dry]
//
// SOURCE
// ------
//   Abbate, Bruni & Sagri — Geological Map of Somalia, scale 1:1,500,000
//   Digitized vector, UNESCO IHP-WINS (Regional Office for Eastern Africa)
//   https://ihp-wins.unesco.org/dataset/geological-map-of-somalia-1-1-500-000
//   Resource: soamlia_geology_1.5m.zip (SHP, 27.5 MB) — sic, the filename is misspelt upstream
//
// WHY THIS AND NOT MACROSTRAT
// ---------------------------
// The pack's Macrostrat units are 81 coarse polygons with 24,069 vertices total.
// This is 1,072 polygons with 2,135,161 vertices, carrying the actual Somali
// stratigraphy by name — Auradu Limestones, Yesomma Sandstones, Taleex Evaporites,
// the Qabri Baxar and Inda Ad basement complexes. It is a purpose-made national
// geological map, not a global compilation clipped to a bounding box.
//
// AUDITED BEFORE USE (all eight checks, measured, not assumed)
//   1. vector files    SHP 34 MB + DBF + PRJ + SHX + CPG + QMD; GPKG also published
//   2. geometry        shapefile type 5 Polygon; 305 multipart, up to 74 rings
//   3. count           1,072 polygons (+46 null records, skipped)
//   4. attributes      unit_code (57), unit_name (58), remarks (lithology text), age_range (35)
//   5. CRS             EPSG:32638 — WGS 84 / UTM zone 38N, metres. Reprojected here.
//   6. coverage        40.99–51.49 E, −1.65–11.94 N — the whole country
//   7. TOPOLOGY        82.8% of edges shared by two polygons, stable at 1 m / 0.1 m / 1 cm.
//                      Adjacent units share exact vertex sequences, so a contact can be
//                      lifted out exactly. This is the check that decides the whole job.
//   8. accuracy        0.5 mm at 1:1,500,000 = ±750 m on the ground. RECONNAISSANCE
//                      SCALE. Digitized vertex spacing is ~40 m, far finer than the map
//                      is actually accurate — precision is not accuracy, and the
//                      simplification below is set from the accuracy, not the spacing.
//
// WHAT IS AND IS NOT FABRICATED
// -----------------------------
// A contact here is a boundary the cartographer drew between two named units. That
// is real. Two things are refused:
//   · a shared edge between two polygons of the SAME unit is a map subdivision, not
//     geology, and is discarded (this is the error that got the first attempt deleted);
//   · a unit whose lithology cannot be read from its name or remarks is recorded as
//     "unknown", never guessed. Inda Ad Complex has no remarks, so it stays unknown.
// No faults and no lineaments are produced. A unit boundary may or may not be a
// fault, and the map does not say which, so inventing one would be fabrication.
import { canonicalJson } from "../shared/geo-core/pack/canonical.ts";
import { sha256Hex } from "../shared/geo-core/pack/sha256.ts";
import {
  MANIFEST_FILE, type PackManifest, type PackMapFeature,
} from "../shared/geo-core/pack/types.ts";

function argOf(n: string): string | undefined {
  const i = Deno.args.indexOf(`--${n}`);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}
const SHP_DIR = argOf("shp") ?? ".";
const PACK = argOf("pack") ?? "mobile/assets/geo-pack";
const DRY = Deno.args.includes("--dry");

const SOURCE = "Abbate et al. Geological Map of Somalia";
const SCALE = "1:1,500,000";
const DATASET = "UNESCO IHP-WINS digitized vector";
const DATASET_URL = "https://ihp-wins.unesco.org/dataset/geological-map-of-somalia-1-1-500-000";
const ALGORITHM = "shared-edge extraction between adjacent mapped units";
const ALGORITHM_VERSION = "1.0.0";

/**
 * Vertices are matched at 1 m. The digitizing is exact to far better than that, and
 * 1 m is three orders of magnitude inside the map's own ±750 m accuracy.
 */
const NODE_SNAP_M = 1;
/**
 * Douglas-Peucker tolerance. Set from the map's accuracy, not its vertex spacing:
 * 250 m is a third of the ±750 m the source can actually justify, so simplification
 * stays well inside the error the cartography already carries.
 */
const SIMPLIFY_M = 250;
/** A boundary shorter than this is a digitizing sliver, not a mappable contact. */
const MIN_CONTACT_M = 2_000;

// ── UTM zone 38N (WGS 84) → geographic ──────────────────────────────────────
const A = 6378137.0, F = 1 / 298.257223563, E2 = F * (2 - F);
const K0 = 0.9996, E0 = 500000.0, LON0 = (45 * Math.PI) / 180;
const E1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
function toLngLat(x: number, y: number): [number, number] {
  const M = y / K0;
  const mu = M / (A * (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 ** 3) / 256));
  const p = mu + (1.5 * E1 - (27 * E1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * E1 * E1) / 16 - (55 * E1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * E1 ** 3) / 96) * Math.sin(6 * mu) + ((1097 * E1 ** 4) / 512) * Math.sin(8 * mu);
  const ep2 = E2 / (1 - E2);
  const C = ep2 * Math.cos(p) ** 2, T = Math.tan(p) ** 2;
  const N = A / Math.sqrt(1 - E2 * Math.sin(p) ** 2);
  const R = (A * (1 - E2)) / (1 - E2 * Math.sin(p) ** 2) ** 1.5;
  const D = (x - E0) / (N * K0);
  const lat = p - ((N * Math.tan(p)) / R) * ((D * D) / 2 -
    ((5 + 3 * T + 10 * C - 4 * C * C - 9 * ep2) * D ** 4) / 24 +
    ((61 + 90 * T + 298 * C + 45 * T * T - 252 * ep2 - 3 * C * C) * D ** 6) / 720);
  const lon = LON0 + (D - ((1 + 2 * T + C) * D ** 3) / 6 +
    ((5 - 2 * C + 28 * T - 3 * C * C + 8 * ep2 + 24 * T * T) * D ** 5) / 120) / Math.cos(p);
  return [(lon * 180) / Math.PI, (lat * 180) / Math.PI];
}

// ── Lithology, read off the source's own words ──────────────────────────────
//
// The winning rule is the one whose phrase appears EARLIEST in the text, not the
// one highest in this list. That matters: unit Pl is "Conglomerates, sands and
// shales underlying basalts" — sedimentary rock that lies beneath lava, which a
// list-order match reads as volcanic. Mudug Beds are "Gypsiferous sands and sandy
// clays, limestones and basalts found in wells", likewise sedimentary. A geologist
// names the dominant rock first, so position in the sentence is the signal.
// Every unit's assignment and the phrase that produced it are printed, so the
// mapping can be checked line by line.
const LITHOLOGY_RULES: Array<[string, string]> = [
  // metamorphic
  ["metavolcanic", "metamorphic"], ["metagabbro", "metamorphic"], ["metapelite", "metamorphic"],
  ["metaclastic", "metamorphic"], ["migmatite", "metamorphic"], ["paragneiss", "metamorphic"],
  ["gneiss", "metamorphic"], ["schist", "metamorphic"], ["quartzite", "metamorphic"],
  ["marble", "metamorphic"], ["amphibolite", "metamorphic"],
  // plutonic
  ["granitoid", "plutonic"], ["granite", "plutonic"], ["gabbro", "plutonic"],
  ["syenite", "plutonic"], ["plutonic", "plutonic"], ["diorite", "plutonic"],
  // volcanic
  ["basalt", "volcanic"], ["lava", "volcanic"], ["tuff", "volcanic"],
  ["rhyolite", "volcanic"], ["trachyte", "volcanic"],
  // sedimentary
  ["limestone", "sedimentary"], ["dolostone", "sedimentary"], ["dolomite", "sedimentary"],
  ["sandstone", "sedimentary"], ["calcarenite", "sedimentary"], ["marlstone", "sedimentary"],
  ["conglomerate", "sedimentary"], ["fanglomerate", "sedimentary"], ["evaporite", "sedimentary"],
  ["gypsum", "sedimentary"], ["gypsiferous", "sedimentary"], ["siltstone", "sedimentary"],
  ["shale", "sedimentary"], ["coquin", "sedimentary"], ["marl", "sedimentary"],
  ["clay", "sedimentary"], ["silt", "sedimentary"], ["gravel", "sedimentary"],
  ["sand dune", "sedimentary"], ["beach deposit", "sedimentary"], ["sand", "sedimentary"],
  ["coral", "sedimentary"], ["alluvi", "sedimentary"], ["lignite", "sedimentary"],
];
function earliestMatch(text: string, where: string): { kind: string; via: string } | null {
  const hay = text.toLowerCase();
  let at = Infinity, hit: [string, string] | null = null;
  for (const rule of LITHOLOGY_RULES) {
    const i = hay.indexOf(rule[0]);
    // On a tie the longer phrase wins, so "metagabbro" beats "gabbro" at the same spot.
    if (i >= 0 && (i < at || (i === at && hit !== null && rule[0].length > hit[0].length))) {
      at = i; hit = rule;
    }
  }
  return hit ? { kind: hit[1], via: `${where}:${hit[0]}@${at}` } : null;
}
function classify(name: string, remarks: string): { kind: string; via: string } {
  // The unit's own name first: it is the cartographer's primary statement.
  // Then the remarks, which spell out the lithology of the named formations.
  return earliestMatch(name, "name") ?? earliestMatch(remarks, "remarks") ??
    { kind: "unknown", via: "no lithology stated" };
}

// ── Shapefile + dBASE ───────────────────────────────────────────────────────
const shpPath = `${SHP_DIR}/Somalia_geology_1.5M.shp`;
let shpBytes: Uint8Array;
try {
  shpBytes = await Deno.readFile(shpPath);
} catch {
  console.error(`Cannot read ${shpPath}`);
  console.error(`Download soamlia_geology_1.5m.zip from ${DATASET_URL}, unzip it,`);
  console.error(`and pass the folder with --shp <dir>.`);
  Deno.exit(2);
}
const dbfBytes = await Deno.readFile(`${SHP_DIR}/Somalia_geology_1.5M.dbf`);

interface Unit { key: string; code: string; name: string; kind: string; via: string; rings: number[][] }

function readDbf(bytes: Uint8Array): Array<Record<string, string>> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nrec = v.getInt32(4, true), hlen = v.getUint16(8, true), rlen = v.getUint16(10, true);
  const fields: Array<[string, number]> = [];
  let p = 32;
  const dec = new TextDecoder("latin1");
  while (bytes[p] !== 0x0d) {
    const raw = bytes.subarray(p, p + 11);
    const end = raw.indexOf(0);
    fields.push([dec.decode(end < 0 ? raw : raw.subarray(0, end)), bytes[p + 16]]);
    p += 32;
  }
  const rows: Array<Record<string, string>> = [];
  for (let i = 0; i < nrec; i++) {
    let o = hlen + i * rlen + 1;
    const rec: Record<string, string> = {};
    for (const [nm, len] of fields) { rec[nm] = dec.decode(bytes.subarray(o, o + len)).trim(); o += len; }
    rows.push(rec);
  }
  return rows;
}

const attrs = readDbf(dbfBytes);
const sv = new DataView(shpBytes.buffer, shpBytes.byteOffset, shpBytes.byteLength);
const units: Unit[] = [];
let off = 100, rec = 0, nullRecords = 0;
while (off < shpBytes.length) {
  const length = sv.getInt32(off + 4, false);
  const body = off + 8;
  const st = sv.getInt32(body, true);
  if (st === 5) {
    const nparts = sv.getInt32(body + 36, true), npoints = sv.getInt32(body + 40, true);
    const parts: number[] = [];
    for (let j = 0; j < nparts; j++) parts.push(sv.getInt32(body + 44 + 4 * j, true));
    const pb = body + 44 + 4 * nparts;
    const rings: number[][] = [];
    for (let j = 0; j < nparts; j++) {
      const s = parts[j], e = j + 1 < nparts ? parts[j + 1] : npoints;
      const ring = new Array<number>((e - s) * 2);
      for (let i = s; i < e; i++) {
        ring[(i - s) * 2] = sv.getFloat64(pb + 16 * i, true);
        ring[(i - s) * 2 + 1] = sv.getFloat64(pb + 16 * i + 8, true);
      }
      rings.push(ring);
    }
    const a = attrs[rec] ?? {};
    const code = a.unit_code ?? "", name = a.unit_name ?? "", remarks = a.remarks ?? "";
    const { kind, via } = classify(name, remarks);
    units.push({ key: `${code}|${name}`, code, name, kind, via, rings });
  } else nullRecords++;
  off = body + length * 2;
  rec++;
}
console.log(`${units.length} polygons (${nullRecords} null records skipped)`);

// Two records carry a unit_code but no name and no remarks. Their code is in the
// legend elsewhere, so the lithology is taken from the other polygons of the same
// code — the same entry in the same legend, not an inference about the rock.
const kindByCode = new Map<string, string>();
for (const u of units) if (u.kind !== "unknown" && !kindByCode.has(u.code)) kindByCode.set(u.code, u.kind);
for (const u of units) {
  if (u.kind !== "unknown") continue;
  const fromCode = kindByCode.get(u.code);
  if (fromCode) { u.kind = fromCode; u.via = `code:${u.code} (blank name/remarks)`; }
}

// ── Report the lithology mapping in full ────────────────────────────────────
const byUnit = new Map<string, Unit>();
for (const u of units) if (!byUnit.has(u.key)) byUnit.set(u.key, u);
const kindCount = new Map<string, number>();
console.log(`\n=== LITHOLOGY ASSIGNED FROM THE SOURCE'S OWN TEXT (${byUnit.size} units) ===`);
for (const u of [...byUnit.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.code.localeCompare(b.code))) {
  kindCount.set(u.kind, (kindCount.get(u.kind) ?? 0) + 1);
  console.log(`  ${u.kind.padEnd(12)} ${u.code.padEnd(6)} ${u.name.slice(0, 42).padEnd(42)} <- ${u.via}`);
}
console.log(`  ` + [...kindCount].map(([k, v]) => `${k}=${v}`).join(", "));
const unknown = kindCount.get("unknown") ?? 0;
if (unknown / byUnit.size > 0.15) {
  console.error(`REFUSED: ${unknown} of ${byUnit.size} units have no stated lithology. The rules ` +
    `are not reading this source properly; fix them rather than guessing the rock types.`);
  Deno.exit(3);
}

// ── GATE 1: are these real outlines, or sampling rectangles? ────────────────
let vertices = 0, gridVerts = 0, rectangles = 0;
for (const u of units) {
  if (u.rings.every((r) => r.length <= 10)) rectangles++;
  for (const r of u.rings) {
    for (let i = 0; i < r.length; i += 2) {
      vertices++;
      const [lng, lat] = toLngLat(r[i], r[i + 1]);
      if (Math.abs(lng * 4 - Math.round(lng * 4)) < 1e-6 || Math.abs(lat * 4 - Math.round(lat * 4)) < 1e-6) gridVerts++;
    }
  }
}
const gridFraction = gridVerts / Math.max(1, vertices);
console.log(`\n=== GATE 1 — outlines, not a sampling grid ===`);
console.log(`  ${vertices.toLocaleString()} vertices, ${rectangles} near-rectangular polygons, ` +
  `${(gridFraction * 100).toFixed(3)}% on a 0.25° line`);
if (gridFraction > 0.05) {
  console.error(`REFUSED: ${(gridFraction * 100).toFixed(1)}% grid-aligned. These would be pipeline ` +
    `lines, not geology — the ST_MakeEnvelope failure all over again.`);
  Deno.exit(3);
}
console.log(`  PASS`);

// ── Shared edges between DIFFERENT units ────────────────────────────────────
//
// Different unit, not merely different lithology class: Auradu Limestones against
// Yesomma Sandstones is a real formation contact even though both are sedimentary.
// Same unit either side is a map subdivision and is thrown away.
const nodeXY: number[] = [];
const nodeId = new Map<string, number>();
function node(x: number, y: number): number {
  const k = `${Math.round(x / NODE_SNAP_M)},${Math.round(y / NODE_SNAP_M)}`;
  let id = nodeId.get(k);
  if (id === undefined) {
    id = nodeXY.length / 2;
    nodeXY.push(x, y);
    nodeId.set(k, id);
  }
  return id;
}

const edgeUnits = new Map<string, number[]>();   // edge -> unit indices
const edgeNodes = new Map<string, [number, number]>();
for (let ui = 0; ui < units.length; ui++) {
  for (const r of units[ui].rings) {
    let prev = node(r[0], r[1]);
    for (let i = 2; i < r.length; i += 2) {
      const cur = node(r[i], r[i + 1]);
      if (cur !== prev) {
        const k = prev < cur ? `${prev}_${cur}` : `${cur}_${prev}`;
        let l = edgeUnits.get(k);
        if (!l) { l = []; edgeUnits.set(k, l); edgeNodes.set(k, [prev, cur]); }
        if (!l.includes(ui)) l.push(ui);
      }
      prev = cur;
    }
  }
}

interface ContactEdge { a: number; b: number; pair: string }
const contactEdges: ContactEdge[] = [];
const pairMeta = new Map<string, { u1: Unit; u2: Unit }>();
let sameUnit = 0, unsharedEdges = 0, manyUnits = 0;
for (const [k, list] of edgeUnits) {
  if (list.length === 1) { unsharedEdges++; continue; }        // coast, border, map margin
  if (list.length > 2) { manyUnits++; continue; }              // a digitizing overlap; not trusted
  const u1 = units[list[0]], u2 = units[list[1]];
  if (u1.key === u2.key) { sameUnit++; continue; }             // map subdivision, NOT a contact
  const pair = u1.key < u2.key ? `${u1.key}::${u2.key}` : `${u2.key}::${u1.key}`;
  if (!pairMeta.has(pair)) pairMeta.set(pair, u1.key < u2.key ? { u1, u2 } : { u1: u2, u2: u1 });
  const [a, b] = edgeNodes.get(k)!;
  contactEdges.push({ a, b, pair });
}
console.log(`\n=== SHARED-EDGE EXTRACTION ===`);
console.log(`  ${edgeUnits.size.toLocaleString()} distinct edges`);
console.log(`  ${unsharedEdges.toLocaleString()} on one polygon only — coastline, border, map margin`);
console.log(`  ${sameUnit.toLocaleString()} between two polygons of the SAME unit — subdivisions, DISCARDED`);
console.log(`  ${manyUnits.toLocaleString()} shared by 3+ polygons — overlaps, discarded`);
console.log(`  ${contactEdges.length.toLocaleString()} between DIFFERENT units — real contacts`);
console.log(`  ${pairMeta.size} distinct unit pairs in contact`);

// ── Chain into polylines, one unit pair at a time ───────────────────────────
const byPair = new Map<string, ContactEdge[]>();
for (const e of contactEdges) {
  let g = byPair.get(e.pair);
  if (!g) { g = []; byPair.set(e.pair, g); }
  g.push(e);
}

function chain(group: ContactEdge[]): number[][] {
  const adj = new Map<number, Array<[number, number]>>();   // node -> [neighbour, edge index]
  for (let i = 0; i < group.length; i++) {
    for (const [from, to] of [[group[i].a, group[i].b], [group[i].b, group[i].a]]) {
      let l = adj.get(from);
      if (!l) { l = []; adj.set(from, l); }
      l.push([to, i]);
    }
  }
  const used = new Uint8Array(group.length);
  // Walk away from `start`, taking the only unused edge each time. A junction where
  // three units meet has two options and ends the line — which is correct: that is
  // where one contact stops and another begins.
  const extend = (start: number): number[] => {
    const out: number[] = [];
    let cur = start;
    for (let guard = 0; guard < group.length + 1; guard++) {
      const opts = (adj.get(cur) ?? []).filter(([, id]) => !used[id]);
      if (opts.length !== 1) break;
      used[opts[0][1]] = 1;
      cur = opts[0][0];
      out.push(cur);
    }
    return out;
  };
  const lines: number[][] = [];
  for (let i = 0; i < group.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const left = extend(group[i].a).reverse();
    const right = extend(group[i].b);
    lines.push([...left, group[i].a, group[i].b, ...right]);
  }
  return lines;
}

/** Douglas-Peucker in UTM metres, so the tolerance really is metres. */
function simplify(pts: number[][], tol: number): number[][] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const [x1, y1] = pts[s], [x2, y2] = pts[e];
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let far = -1, best = tol;
    for (let i = s + 1; i < e; i++) {
      const [px, py] = pts[i];
      let d: number;
      if (len2 === 0) d = Math.hypot(px - x1, py - y1);
      else {
        const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
        d = Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
      }
      if (d > best) { best = d; far = i; }
    }
    if (far > 0) { keep[far] = 1; stack.push([s, far], [far, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

const features: PackMapFeature[] = [];
let seq = 0, tooShort = 0, keptM = 0, rawVerts = 0, keptVerts = 0;
for (const [pair, group] of byPair) {
  const { u1, u2 } = pairMeta.get(pair)!;
  for (const line of chain(group)) {
    const utm = line.map((n) => [nodeXY[n * 2], nodeXY[n * 2 + 1]]);
    let lengthM = 0;
    for (let i = 1; i < utm.length; i++) lengthM += Math.hypot(utm[i][0] - utm[i - 1][0], utm[i][1] - utm[i - 1][1]);
    if (lengthM < MIN_CONTACT_M) { tooShort++; continue; }
    rawVerts += utm.length;
    const thin = simplify(utm, SIMPLIFY_M);
    keptVerts += thin.length;
    keptM += lengthM;
    const ll = thin.map(([x, y]) => toLngLat(x, y));
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [lng, lat] of ll) {
      if (lng < w) w = lng; if (lng > e) e = lng;
      if (lat < s) s = lat; if (lat > n) n = lat;
    }
    features.push({
      id: `contact_abbate_${seq++}`,
      kind: "contact",
      name: `${u1.name || u1.code} / ${u2.name || u2.code}`,
      source: SOURCE,
      attributes: {
        source: SOURCE,
        scale: SCALE,
        dataset: DATASET,
        dataset_url: DATASET_URL,
        algorithm: ALGORITHM,
        algorithm_version: ALGORITHM_VERSION,
        // Reconnaissance scale. Carried on every feature so nothing downstream can
        // treat one of these lines as a surveyed position.
        positional_accuracy_m: 750,
        simplify_tolerance_m: SIMPLIFY_M,
        units: [u1.code, u2.code],
        unit_names: [u1.name, u2.name],
        lithologies: [u1.kind, u2.kind],
        lithology_change: u1.kind !== u2.kind && u1.kind !== "unknown" && u2.kind !== "unknown",
        length_m: Math.round(lengthM),
        derived_at: new Date().toISOString(),
      },
      lines: [ll as PackMapFeature["lines"][number]],
      bbox: [w, s, e, n],
    });
  }
}
console.log(`\n=== CONTACTS ===`);
console.log(`  ${features.length.toLocaleString()} features, ${Math.round(keptM / 1000).toLocaleString()} km total`);
console.log(`  ${tooShort.toLocaleString()} discarded as slivers under ${MIN_CONTACT_M / 1000} km`);
console.log(`  ${rawVerts.toLocaleString()} vertices -> ${keptVerts.toLocaleString()} after ` +
  `${SIMPLIFY_M} m simplification (${(100 - (keptVerts / rawVerts) * 100).toFixed(1)}% reduction)`);
const changed = features.filter((f) => (f.attributes as { lithology_change: boolean }).lithology_change).length;
console.log(`  ${changed.toLocaleString()} cross a lithology class boundary; ${features.length - changed} join units of the same class`);

// ── GATE 2: is the OUTPUT grid lines? ───────────────────────────────────────
let outVerts = 0, outGrid = 0;
for (const f of features) {
  for (const [lng, lat] of f.lines[0] as Array<[number, number]>) {
    outVerts++;
    if (Math.abs(lng * 4 - Math.round(lng * 4)) < 1e-6 || Math.abs(lat * 4 - Math.round(lat * 4)) < 1e-6) outGrid++;
  }
}
console.log(`\n=== GATE 2 — the output is geology, not pipeline lines ===`);
console.log(`  ${((outGrid / Math.max(1, outVerts)) * 100).toFixed(3)}% of contact vertices on a 0.25° line`);
if (outGrid / Math.max(1, outVerts) > 0.05) {
  console.error(`REFUSED: the derived contacts are grid-aligned.`);
  Deno.exit(3);
}
if (features.length < 100) {
  console.error(`REFUSED: only ${features.length} contacts from 1,072 polygons. The chaining is wrong.`);
  Deno.exit(3);
}
console.log(`  PASS`);

if (DRY) {
  console.log(`\n--dry: nothing written.`);
  Deno.exit(0);
}

// ── Into the pack ───────────────────────────────────────────────────────────
const layersPath = `${PACK}/maplayers.json`;
const layers = JSON.parse(await Deno.readTextFile(layersPath)) as {
  formatVersion: number; kind: string; rows: PackMapFeature[];
};
const kept = layers.rows.filter((r) => r.kind !== "contact");
const rows = [...kept, ...features].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
console.log(`\nmaplayers: ${kept.length.toLocaleString()} kept + ${features.length.toLocaleString()} contacts ` +
  `= ${rows.length.toLocaleString()} (replaced ${(layers.rows.length - kept.length).toLocaleString()} old contacts)`);

const body = canonicalJson({ ...layers, rows });
await Deno.writeTextFile(layersPath, body);

const manifestPath = `${PACK}/${MANIFEST_FILE}`;
const manifest = JSON.parse(await Deno.readTextFile(manifestPath)) as PackManifest;
manifest.files["maplayers.json"] = sha256Hex(body);
if (manifest.counts) manifest.counts.mapFeatures = rows.length;
manifest.sha256 = sha256Hex(canonicalJson(manifest.files));
await Deno.writeTextFile(manifestPath, canonicalJson(manifest));
console.log(`manifest rewritten — maplayers.json ${(body.length / 1e6).toFixed(1)} MB`);

console.log(`\nCONTACTS ARE STILL NOT SCORED. They stay in ROLES_NOT_SCORED until the`);
console.log(`leakage and usefulness gates run:  npx jest lib/__tests__/prospectivityBaseline.test.ts`);

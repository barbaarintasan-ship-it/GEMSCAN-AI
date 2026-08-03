// Is the knowledge pack actually inside the shipped JS bundle?
//
//   node scripts/verify-bundled-pack.mjs <path-to-index.android.bundle>
//
// WHY THIS EXISTS
// ---------------
// The Jest suite proves the pack is well-formed and that the loading logic
// works. It cannot prove that METRO carried the files, because Jest resolves
// `require` through its own transformer. Those are different questions, and
// this project has already shipped a build where the answer to the second was
// no: mobile/lib/geo/bundledPack.ts listed ten of twelve pack files after two
// were added, and the app silently ran with an incomplete pack.
//
// A grep for a component name is NOT evidence either — that mistake has been
// made here too. Ionicons embeds every glyph name in the bundle, so finding
// "compass-outline" proved nothing about whether a button existed. So this
// checks for CONTENT that could only come from the pack itself: the exact
// manifest hashes, real unit names, and the record counts.
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const bundlePath = process.argv[2];
const packDir = process.argv[3] ?? "mobile/assets/geo-pack";

if (!bundlePath || !existsSync(bundlePath)) {
  console.error(`bundle not found: ${bundlePath}`);
  process.exit(2);
}

const bundle = readFileSync(bundlePath, "utf8");
console.log(`bundle: ${(bundle.length / 1e6).toFixed(1)} MB`);

const manifest = JSON.parse(readFileSync(join(packDir, "manifest.json"), "utf8"));
const failures = [];
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures.push(m); console.log(`  FAIL  ${m}`); };

// ── 1. The manifest itself ──────────────────────────────────────────────────
// Its sha256 is a 64-hex string that appears nowhere else on earth, so finding
// it in the bundle is proof the manifest was carried, not merely referenced.
console.log("\nmanifest");
bundle.includes(manifest.sha256)
  ? pass(`manifest sha256 ${manifest.sha256.slice(0, 16)}… is in the bundle`)
  : fail("manifest sha256 is NOT in the bundle — the manifest was not embedded");

bundle.includes(manifest.packVersion)
  ? pass(`packVersion ${manifest.packVersion} present`)
  : fail(`packVersion ${manifest.packVersion} missing`);

// ── 2. Every declared file ──────────────────────────────────────────────────
// Each file's own sha256 is listed in the manifest. If the manifest is in the
// bundle, every hash is too — so this instead checks that each file's DATA is
// there, by looking for a value that only that file contains.
console.log("\ndeclared files");
const names = Object.keys(manifest.files).sort();
console.log(`  manifest declares ${names.length} files`);

for (const name of names) {
  const raw = readFileSync(join(packDir, name), "utf8");
  const parsed = JSON.parse(raw);
  const rows = parsed.rows ?? [];

  if (rows.length === 0) {
    // An empty layer is legitimate (knowledge/community/structures are empty in
    // this pack). There is no content to look for, so the file's presence is
    // taken from the manifest check above rather than being faked.
    pass(`${name.padEnd(20)} declared empty — nothing to look for`);
    continue;
  }

  // A distinctive value from the LAST row: last, because a truncated embed
  // would keep the first rows and lose the tail.
  const last = rows[rows.length - 1];
  const probe =
    typeof last.id === "string" ? last.id
    : typeof last.cell === "string" ? last.cell
    : typeof last.name === "string" ? last.name
    : JSON.stringify(last).slice(0, 40);

  bundle.includes(probe)
    ? pass(`${name.padEnd(20)} ${String(rows.length).padStart(5)} rows — last row present`)
    : fail(`${name.padEnd(20)} last row NOT in bundle (${probe.slice(0, 40)})`);
}

// ── 3. The geology, specifically ────────────────────────────────────────────
// This is the layer that was wrong, so it is checked hardest.
console.log("\ngeology");
const geology = JSON.parse(readFileSync(join(packDir, "geology.json"), "utf8")).rows;
console.log(`  ${geology.length} units on disk`);

const boxes = geology.filter((u) => u.rings.every((r) => r.length <= 5));
boxes.length === 0
  ? pass("no unit is a 4-5 point box — these are polygons, not a sampling grid")
  : fail(`${boxes.length} units are boxes — the sampling-grid artifact is back`);

const vertices = geology.reduce((a, u) => a + u.rings.reduce((b, r) => b + r.length, 0), 0);
vertices > 5000
  ? pass(`${vertices} vertices of real geometry`)
  : fail(`only ${vertices} vertices — too few to be mapped boundaries`);

// A long coordinate run from the largest unit. Coordinates are the bulk of the
// pack and the first thing a broken embed would drop.
const biggest = [...geology].sort(
  (a, b) => b.rings[0].length - a.rings[0].length,
)[0];
const run = JSON.stringify(biggest.rings[0].slice(0, 8));
bundle.includes(run.slice(1, -1))
  ? pass(`coordinate run from "${biggest.name}" found verbatim in the bundle`)
  : fail(`coordinates of "${biggest.name}" are NOT in the bundle`);

for (const n of ["Neoproterozoic", "Cenozoic", "Mesozoic"]) {
  bundle.includes(n)
    ? pass(`unit age "${n}" present`)
    : fail(`unit age "${n}" missing`);
}

// ── 4. The loader lists what the manifest declares ──────────────────────────
// The failure this catches is a file added to the pack but not to the require
// list — which the app cannot detect at build time.
console.log("\nloader");
const loader = readFileSync("mobile/lib/geo/bundledPack.ts", "utf8");
const required = [...loader.matchAll(/geo-pack\/([\w.]+\.json)/g)].map((m) => m[1]).sort();
const expected = [...names, "manifest.json"].sort();
JSON.stringify(required) === JSON.stringify(expected)
  ? pass(`bundledPack.ts requires all ${required.length} files`)
  : fail(`loader requires [${required}] but manifest declares [${expected}]`);

// ── 5. Integrity, recomputed here ───────────────────────────────────────────
console.log("\nintegrity");
for (const [name, hash] of Object.entries(manifest.files)) {
  const actual = createHash("sha256").update(readFileSync(join(packDir, name), "utf8")).digest("hex");
  actual === hash
    ? pass(`${name.padEnd(20)} sha256 matches`)
    : fail(`${name.padEnd(20)} sha256 MISMATCH — pack file edited without rehashing`);
}

// ── 6. The screens that use it ──────────────────────────────────────────────
// Shipping the data and shipping the code that reads it are separate failures.
// A build once went out where the Exploration button was reported as present
// because "compass-outline" appeared in the bundle — it appears in EVERY build,
// because Ionicons embeds every glyph name. So the probes below are STRING
// LITERALS unique to the new code. Identifier names are not usable: the
// minifier renames every local, so a missing `startBurst` proves nothing.
console.log("\nscreens");
const PROBES = [
  ["exploration map surface", "__setLive"],
  ["map gesture handling", "touchmove"],
  ["map layer panel", "field.map.layersTitle"],
  ["bottom sheet", "field.sheet.interpretation"],
  ["arrival + scan area", "field.arrived.scanArea"],
  ["field camera", "camera.burstHint"],
  ["field camera focus lock", "camera.focusLock"],
  // The key is assembled from a template literal at runtime, so the FULL key
  // never appears in the bundle. Probe the parts that do: the prefix, the
  // locale leaf, and the translated label a geologist would actually read.
  ["requested-shot key prefix", "camera.need."],
  ["requested-shot locale leaf", "fresh_surface"],
  ["requested-shot label (so)", "Dhinac cusub oo la jebiyay"],
  ["satellite tile cache", "sat-tiles"],
  ["pack self-check", "Knowledge pack NOT usable"],
  ["nearest-known evidence", "field.evidence2.farOccurrence"],
  ["Somali locale", "WAXA UGU DHOW EE LA OGYAHAY, OO FOG"],
];
for (const [what, probe] of PROBES) {
  bundle.includes(probe)
    ? pass(`${what.padEnd(28)} shipped`)
    : fail(`${what} is NOT in the bundle (probe: ${probe})`);
}

// ── Verdict ─────────────────────────────────────────────────────────────────
console.log("");
if (failures.length) {
  console.error(`FAILED — ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  • ${f}`);
  process.exit(1);
}
console.log("The knowledge pack is present and complete in the shipped bundle.");

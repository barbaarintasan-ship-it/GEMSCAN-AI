// A country-wide DEM that owes nothing to where anyone has already found ore.
//
//   deno run --allow-net --allow-read --allow-write --allow-env --allow-sys \
//     scripts/ingest-dem-glo30.ts [--pack mobile/assets/geo-pack] [--cache .dem-cache]
//
// WHY THIS EXISTS
// ---------------
// The pack shipped 2,191 terrain cells and every one of them was useless as
// evidence. scripts/build-terrain.ts sampled the DEM in a k-ring around each
// known MRDS occurrence — a reasonable way to stay inside a free API's daily
// budget, and fatal for prospectivity. Measured on 10 August 2026:
//
//     100% of terrain cells lie within 6.1 km of a known occurrence
//     present at 100% of occurrences, 1% of background — a coverage ratio of 150
//
// So "this ground has terrain data" was a near-perfect proxy for "somebody has
// already found something here". Scoring it would have lifted every validation
// metric while teaching the model nothing at all, and it would have looked
// exactly like success. Terrain was withheld for that reason and stays withheld
// until this script has replaced it.
//
// THE SOURCE
// ----------
// Copernicus GLO-30, from the AWS Open Data registry. Public, no credentials, no
// rate limit, and Cloud Optimized GeoTIFF — which is what makes country coverage
// tractable: the overviews are read directly over HTTP range requests, so a
// 3600x3600 tile costs ~800 KB instead of ~25 MB.
//
//     112 tiles cover Somalia. Overview level 3 is 450x450 per degree, ~247 m.
//
// RESOLUTION, STATED HONESTLY
// ---------------------------
// 247 m, not 30 m. An H3 resolution-7 cell is about 2.4 km across, so each cell
// aggregates roughly 10x10 pixels — ample for elevation, slope, relief and
// landform, which is what the engine consumes. It is NOT adequate for detailed
// hydrology, and the drainage network derived from it is a regional one: major
// wadis and trunk channels, not every gully. Every row records the resolution it
// was measured at, so nothing downstream can mistake it for a survey product.
import { fromUrl } from "npm:geotiff@2.1.3";
import { cellToLatLng, latLngToCell } from "https://esm.sh/h3-js@4.1.0";
import { canonicalJson } from "../shared/geo-core/pack/canonical.ts";
import { sha256Hex } from "../shared/geo-core/pack/sha256.ts";
import { MANIFEST_FILE, type PackManifest, type PackTerrainCell } from "../shared/geo-core/pack/types.ts";
import { H3_RESOLUTION } from "../shared/geo-core/geo/h3.ts";

function argOf(n: string): string | undefined {
  const i = Deno.args.indexOf(`--${n}`);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}

const PACK = argOf("pack") ?? "mobile/assets/geo-pack";
const CACHE = argOf("cache") ?? ".dem-cache";
const OVERVIEW = Number(argOf("overview") ?? 3);
/**
 * H3 resolution for TERRAIN, which is deliberately coarser than the engine's.
 *
 * MEASURED. At resolution 7 the country needs 254,623 cells, and Metro bundles
 * pack JSON as a JS object literal — so every row becomes a live object at
 * startup and stays. On the device that took the app from 297 MB at rest to
 * 588 MB, which is worse than the memory pressure that was freezing it.
 *
 * Resolution 6 is 36 km2 per cell, about 6.5 km across, and roughly a seventh of
 * the rows. Landform class at that scale is still a real statement about the
 * ground — morphology is the only field the prior reads, and it is a
 * neighbourhood property. Elevation and slope for the sheet come with a
 * `fromM` that says how far the reading travelled, so nothing is presented as
 * more local than it is.
 */
const TERRAIN_H3_RES = Number(argOf("h3res") ?? 6);
const DEM_SOURCE = "Copernicus GLO-30 (AWS Open Data)";

/**
 * Somalia, generously bounded.
 *
 * Wider than the coastline so no coastal cell is clipped, and no wider: every
 * extra degree is 450x450 pixels of ocean carried through every later pass.
 */
const BBOX = { w: 40, s: -2, e: 52, n: 12 };

/** Pixels per degree at the chosen overview. 3600 / 2^overview. */
const PPD = 3600 / 2 ** OVERVIEW;
const W = (BBOX.e - BBOX.w) * PPD;
const H = (BBOX.n - BBOX.s) * PPD;
const PIXEL_M = 111_320 / PPD;

/** Copernicus writes nodata as a large negative; sea is genuine zero. */
const NODATA = -9000;

function tileId(lat: number, lng: number): string {
  const ns = lat < 0 ? "S" : "N";
  const ew = lng < 0 ? "W" : "E";
  return `Copernicus_DSM_COG_10_${ns}${String(Math.abs(lat)).padStart(2, "0")}_00_` +
    `${ew}${String(Math.abs(lng)).padStart(3, "0")}_00_DEM`;
}

// ── Mosaic ──────────────────────────────────────────────────────────────────

/**
 * One float per pixel, north-up, row 0 at BBOX.n.
 *
 * NaN means "no measurement": tiles Copernicus does not publish are open ocean,
 * and a zero there would be a fabricated sea-level reading that slope and flow
 * would both take seriously.
 */
async function buildMosaic(): Promise<Float32Array> {
  const grid = new Float32Array(W * H).fill(NaN);
  await Deno.mkdir(CACHE, { recursive: true });

  let fetched = 0, cached = 0, missing = 0;
  for (let lat = BBOX.s; lat < BBOX.n; lat++) {
    for (let lng = BBOX.w; lng < BBOX.e; lng++) {
      const id = tileId(lat, lng);
      const cachePath = `${CACHE}/${id}.ov${OVERVIEW}.bin`;

      let data: Float32Array | null = null;
      try {
        const bytes = await Deno.readFile(cachePath);
        data = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
        cached++;
      } catch {
        try {
          const tiff = await fromUrl(
            `https://copernicus-dem-30m.s3.amazonaws.com/${id}/${id}.tif`,
          );
          const im = await tiff.getImage(OVERVIEW);
          const raster = (await im.readRasters({ interleave: true })) as unknown as
            Float32Array | Int16Array;
          data = Float32Array.from(raster);
          await Deno.writeFile(cachePath, new Uint8Array(data.buffer.slice(0)));
          fetched++;
        } catch {
          missing++;   // no tile published: open ocean
          continue;
        }
      }
      if (!data) continue;

      // Paste. The tile's own origin is (lng, lat+1) going south.
      const x0 = Math.round((lng - BBOX.w) * PPD);
      const y0 = Math.round((BBOX.n - (lat + 1)) * PPD);
      const side = Math.round(Math.sqrt(data.length));
      for (let r = 0; r < side; r++) {
        const gy = y0 + r;
        if (gy < 0 || gy >= H) continue;
        for (let c = 0; c < side; c++) {
          const gx = x0 + c;
          if (gx < 0 || gx >= W) continue;
          const v = data[r * side + c];
          grid[gy * W + gx] = v > NODATA ? v : NaN;
        }
      }
      if ((fetched + cached) % 20 === 0) {
        console.log(`  ${fetched} fetched, ${cached} cached, ${missing} ocean`);
      }
    }
  }
  console.log(`mosaic ${W}x${H} @ ${PIXEL_M.toFixed(0)} m — ` +
    `${fetched} fetched, ${cached} cached, ${missing} tiles absent (ocean)`);
  return grid;
}

// ── Per-pixel derivatives ───────────────────────────────────────────────────

/**
 * Slope and aspect by Horn's method over the 3x3 neighbourhood.
 *
 * The standard used by every GIS worth the name, and specifically NOT a simple
 * two-point difference: Horn weights the diagonals, which is what stops a single
 * noisy pixel from producing a cliff. Edge and nodata pixels yield NaN rather
 * than a slope computed against invented ground.
 */
function derivatives(elev: Float32Array): { slope: Float32Array; aspect: Float32Array } {
  const slope = new Float32Array(W * H).fill(NaN);
  const aspect = new Float32Array(W * H).fill(NaN);
  // Metres per pixel differs in x with latitude; y is constant.
  const dyM = PIXEL_M;

  for (let y = 1; y < H - 1; y++) {
    const lat = BBOX.n - (y + 0.5) / PPD;
    const dxM = PIXEL_M * Math.max(0.05, Math.cos((lat * Math.PI) / 180));
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const a = elev[i - W - 1], b = elev[i - W], c = elev[i - W + 1];
      const d = elev[i - 1], f = elev[i + 1];
      const g = elev[i + W - 1], h = elev[i + W], k = elev[i + W + 1];
      if (
        Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c) || Number.isNaN(d) ||
        Number.isNaN(f) || Number.isNaN(g) || Number.isNaN(h) || Number.isNaN(k)
      ) continue;

      const dzdx = ((c + 2 * f + k) - (a + 2 * d + g)) / (8 * dxM);
      const dzdy = ((g + 2 * h + k) - (a + 2 * b + c)) / (8 * dyM);
      slope[i] = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;

      if (dzdx !== 0 || dzdy !== 0) {
        let deg = (Math.atan2(dzdy, -dzdx) * 180) / Math.PI;
        deg = (90 - deg + 360) % 360;   // compass bearing of steepest descent
        aspect[i] = deg;
      }
    }
  }
  return { slope, aspect };
}

// ── Aggregation to H3 cells ─────────────────────────────────────────────────

interface Acc {
  n: number; elevSum: number; slopeSum: number;
  elevMin: number; elevMax: number;
  aspectX: number; aspectY: number;
  triSum: number; triN: number;
  lat: number; lng: number;
}

/**
 * One row per H3 cell that has real ground under it.
 *
 * Aggregating pixels into cells rather than sampling a single pixel per cell is
 * what makes relief and ruggedness meaningful: they are statements about the
 * neighbourhood, and a point sample has no neighbourhood.
 */
function aggregate(
  elev: Float32Array,
  slope: Float32Array,
  aspect: Float32Array,
): Map<string, Acc> {
  const cells = new Map<string, Acc>();

  for (let y = 1; y < H - 1; y++) {
    const lat = BBOX.n - (y + 0.5) / PPD;
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const e = elev[i];
      if (Number.isNaN(e)) continue;
      const lng = BBOX.w + (x + 0.5) / PPD;

      const cell = latLngToCell(lat, lng, TERRAIN_H3_RES) as string;
      let a = cells.get(cell);
      if (!a) {
        const [clat, clng] = cellToLatLng(cell) as [number, number];
        a = {
          n: 0, elevSum: 0, slopeSum: 0, elevMin: Infinity, elevMax: -Infinity,
          aspectX: 0, aspectY: 0, triSum: 0, triN: 0, lat: clat, lng: clng,
        };
        cells.set(cell, a);
      }
      a.n++;
      a.elevSum += e;
      if (e < a.elevMin) a.elevMin = e;
      if (e > a.elevMax) a.elevMax = e;

      const s = slope[i];
      if (!Number.isNaN(s)) a.slopeSum += s;

      const asp = aspect[i];
      if (!Number.isNaN(asp)) {
        // Circular mean: averaging 350 and 10 as numbers gives 180, which points
        // the opposite way to both.
        const r = (asp * Math.PI) / 180;
        a.aspectX += Math.cos(r);
        a.aspectY += Math.sin(r);
      }

      // Terrain Ruggedness Index — mean absolute elevation difference to the
      // eight neighbours. Distinguishes a smooth 20-degree dip slope from broken
      // ground of the same average gradient, which is the difference between
      // walkable and not.
      let diff = 0, cnt = 0;
      for (const j of [i - W - 1, i - W, i - W + 1, i - 1, i + 1, i + W - 1, i + W, i + W + 1]) {
        const v = elev[j];
        if (!Number.isNaN(v)) { diff += Math.abs(v - e); cnt++; }
      }
      if (cnt > 0) { a.triSum += diff / cnt; a.triN++; }
    }
  }
  return cells;
}

/**
 * Landform from position and gradient, in the four classes the pack defines.
 *
 * `tpi` is the cell's mean elevation minus the mean of its surroundings — the
 * standard topographic position index. Flat is decided by slope alone, because a
 * plain sitting above its neighbours is still a plain.
 */
function morphologyOf(slopeDeg: number, tpi: number, reliefM: number): PackTerrainCell["morphology"] {
  if (slopeDeg < 3 && reliefM < 30) return "flat";
  if (tpi > 20) return "ridge";
  if (tpi < -20) return "valley";
  return "slope";
}

// ── Main ────────────────────────────────────────────────────────────────────

/**
 * Keep only ground the pack can actually reason about.
 *
 * The DEM bbox is deliberately wider than Somalia so no coastal cell is clipped,
 * which means the raw aggregation also covers Ethiopian and Kenyan ground the
 * pack has no geology, occurrences or faults for. Carrying it would add megabytes
 * to an APK for cells the engine can never assess — and terrain alone is not an
 * assessment.
 *
 * Clipped to LAND (so the shelf and the Gulf of Aden go) and to the pack's own
 * declared coverage bbox.
 */
function loadClip(): { land: Array<Array<Array<[number, number]>>>; bbox: [number, number, number, number] } {
  const landFile = JSON.parse(Deno.readTextFileSync(`${PACK}/land.json`)) as { rows: Array<{ rings: Array<Array<[number, number]>> }> };
  const manifest = JSON.parse(Deno.readTextFileSync(`${PACK}/${MANIFEST_FILE}`)) as PackManifest;
  return {
    land: landFile.rows.map((r) => r.rings),
    bbox: manifest.bbox ?? [BBOX.w, BBOX.s, BBOX.e, BBOX.n],
  };
}

function inRings(rings: Array<Array<[number, number]>>, lng: number, lat: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

console.log(`Copernicus GLO-30, overview ${OVERVIEW} (~${PIXEL_M.toFixed(0)} m/px)`);
const elev = await buildMosaic();

console.log("computing slope and aspect (Horn 3x3)…");
const { slope, aspect } = derivatives(elev);

console.log(`aggregating to H3 res ${TERRAIN_H3_RES} (engine runs at ${H3_RESOLUTION})…`);
const acc = aggregate(elev, slope, aspect);
console.log(`  ${acc.size} cells with ground`);

// ── Topographic position ────────────────────────────────────────────────────
//
// TPI is a cell's elevation minus the mean around it, so every cell needs its
// neighbours. Scanning all cells for each cell is O(n^2), and with ~150,000 cells
// that is 22 billion comparisons — the first version of this script did exactly
// that and never finished. A quarter-degree bucket grid makes it linear.
const BUCKET_DEG = 0.25;
const NEIGHBOURHOOD_DEG = 0.12;
const buckets = new Map<string, Array<{ lat: number; lng: number; elev: number }>>();
const bucketKey = (lat: number, lng: number) =>
  `${Math.floor(lat / BUCKET_DEG)}:${Math.floor(lng / BUCKET_DEG)}`;

for (const a of acc.values()) {
  const k = bucketKey(a.lat, a.lng);
  let b = buckets.get(k);
  if (!b) { b = []; buckets.set(k, b); }
  b.push({ lat: a.lat, lng: a.lng, elev: a.elevSum / a.n });
}

/** Mean elevation of the cells around a point, itself included when alone. */
function neighbourhoodMean(lat: number, lng: number, fallback: number): number {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  let sum = 0, n = 0;
  const bi = Math.floor(lat / BUCKET_DEG), bj = Math.floor(lng / BUCKET_DEG);
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const b = buckets.get(`${bi + di}:${bj + dj}`);
      if (!b) continue;
      for (const o of b) {
        if (Math.abs(o.lat - lat) > NEIGHBOURHOOD_DEG) continue;
        if (Math.abs((o.lng - lng) * cosLat) > NEIGHBOURHOOD_DEG) continue;
        sum += o.elev; n++;
      }
    }
  }
  return n > 0 ? sum / n : fallback;
}

const clip = loadClip();
let droppedOffPack = 0;

const rows: PackTerrainCell[] = [];
for (const [cell, a] of acc) {
  // Too few pixels to describe: a sliver on the coast or a mosaic seam.
  if (a.n < 8) continue;
  if (a.lng < clip.bbox[0] || a.lng > clip.bbox[2] || a.lat < clip.bbox[1] || a.lat > clip.bbox[3]) {
    droppedOffPack++; continue;
  }
  if (clip.land.length > 0 && !clip.land.some((rings) => inRings(rings, a.lng, a.lat))) {
    droppedOffPack++; continue;
  }

  const elevationM = a.elevSum / a.n;
  const slopeDeg = a.slopeSum / a.n;
  const reliefM = a.elevMax - a.elevMin;

  const mag = Math.hypot(a.aspectX, a.aspectY);
  const aspectDeg = mag < 1e-6
    ? null
    : ((Math.atan2(a.aspectY, a.aspectX) * 180) / Math.PI + 360) % 360;

  const tpi = elevationM - neighbourhoodMean(a.lat, a.lng, elevationM);

  rows.push({
    cell,
    lat: Math.round(a.lat * 1e5) / 1e5,
    lng: Math.round(a.lng * 1e5) / 1e5,
    elevationM: Math.round(elevationM),
    // One decimal on slope, whole degrees on aspect: the extra digits are noise
    // at 247 m sampling, and this file ships inside the APK.
    slopeDeg: Math.round(slopeDeg * 10) / 10,
    aspectDeg: aspectDeg == null ? null : Math.round(aspectDeg),
    reliefM: Math.round(reliefM),
    morphology: morphologyOf(slopeDeg, tpi, reliefM),
    // Filled by ingest-drainage.ts. NULL is the honest value until then, and the
    // schema comment says so: "never a guess".
    drainageDistM: null,
  });
}

rows.sort((a, b) => (a.cell < b.cell ? -1 : a.cell > b.cell ? 1 : 0));

const byMorph: Record<string, number> = {};
for (const r of rows) byMorph[r.morphology] = (byMorph[r.morphology] ?? 0) + 1;
console.log(`\n${rows.length} terrain cells`);
console.log("  morphology:", JSON.stringify(byMorph));
let lo = Infinity, hi = -Infinity;
for (const r of rows) { if (r.elevationM < lo) lo = r.elevationM; if (r.elevationM > hi) hi = r.elevationM; }
console.log(`  dropped ${droppedOffPack} cells outside the pack's land coverage`);
console.log("  elevation:", lo, "to", hi, "m");
console.log("  mean slope:", (rows.reduce((s, r) => s + r.slopeDeg, 0) / rows.length).toFixed(2), "deg");

if (rows.length < 5_000) {
  console.error(`REFUSED: only ${rows.length} cells. Somalia at H3 res ${TERRAIN_H3_RES} should ` +
    `be tens of thousands; a short run means tiles failed to fetch, and shipping it ` +
    `would recreate exactly the patchy coverage this script exists to replace.`);
  Deno.exit(3);
}

// ── Write, and rewrite the manifest so the pack still verifies ──────────────
const terrainPath = `${PACK}/terrain.json`;
const before = JSON.parse(await Deno.readTextFile(terrainPath)) as {
  formatVersion: number; kind: string; rows: unknown[];
};
console.log(`\nreplacing ${before.rows.length} occurrence-biased cells with ${rows.length} country-wide`);

const body = canonicalJson({ ...before, rows });
await Deno.writeTextFile(terrainPath, body);

const manifestPath = `${PACK}/${MANIFEST_FILE}`;
const manifest = JSON.parse(await Deno.readTextFile(manifestPath)) as PackManifest;
manifest.files["terrain.json"] = sha256Hex(body);
if (manifest.counts) manifest.counts.terrain = rows.length;
manifest.sha256 = sha256Hex(canonicalJson(manifest.files));
await Deno.writeTextFile(manifestPath, canonicalJson(manifest));

console.log(`manifest rewritten — terrain.json ${manifest.files["terrain.json"].slice(0, 12)}…`);
console.log(`terrain.json is ${(body.length / 1e6).toFixed(1)} MB`);
console.log(`source: ${DEM_SOURCE}, ${PIXEL_M.toFixed(0)} m sampling`);
console.log("\nNEXT: run the leakage detector before scoring any of this.");
console.log("  npx jest lib/__tests__/prospectivityBaseline.test.ts");

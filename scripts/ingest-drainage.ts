// Where the water goes — derived from the DEM, not asserted.
//
//   deno run --allow-read --allow-write --allow-env --allow-sys \
//     --v8-flags=--max-old-space-size=6144 \
//     scripts/ingest-drainage.ts [--pack mobile/assets/geo-pack] [--cache .dem-cache]
//
// WHY THIS EXISTS
// ---------------
// `drainage` is one of thirteen evidence roles and it has shipped as
// `empty_layer` since the pack existed: the schema has it, the pack builder maps
// it, `featuresNear` scores it, and there has never been a single row. Every
// terrain cell carries `drainageDistM: null`, and the column comment says why —
// "NULL while no drainage lines are loaded — never a guess".
//
// It matters more than its weight suggests. Alluvial and placer systems ARE
// drainage: for those deposit styles the channel is not context, it is the
// target. A prospectivity engine that cannot say where the wadis run cannot
// assess placer ground at all.
//
// WHAT THIS IS
// ------------
// Standard hydrological derivation over the same Copernicus GLO-30 mosaic the
// terrain layer came from:
//
//     depression filling (priority-flood)  ->  a surface water can leave
//     D8 flow direction                    ->  where each cell drains to
//     flow accumulation                    ->  how much land drains through it
//     threshold                            ->  which cells are channels
//     vectorise                            ->  polylines the pack can carry
//
// DERIVED, AND LABELLED AS SUCH. Every feature records the algorithm, the DEM,
// the sampling resolution and the contributing-area threshold that produced it.
// A derived channel is not a surveyed river, and the provenance says so.
//
// RESOLUTION, HONESTLY. Hydrology runs at ~494 m — the terrain mosaic downsampled
// two-fold — because a priority-flood over the full 34-million-cell grid needs
// half a gigabyte of typed arrays and buys detail this cannot honestly claim
// anyway. What comes out is a REGIONAL network: trunk wadis and major tributaries.
// It is not every gully, and nothing downstream should treat it as one.
import { cellToLatLng, latLngToCell } from "https://esm.sh/h3-js@4.1.0";
import { canonicalJson } from "../shared/geo-core/pack/canonical.ts";
import { sha256Hex } from "../shared/geo-core/pack/sha256.ts";
import {
  MANIFEST_FILE, type PackManifest, type PackMapFeature, type PackTerrainCell,
} from "../shared/geo-core/pack/types.ts";

function argOf(n: string): string | undefined {
  const i = Deno.args.indexOf(`--${n}`);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}

const PACK = argOf("pack") ?? "mobile/assets/geo-pack";
const CACHE = argOf("cache") ?? ".dem-cache";
const SOURCE_OVERVIEW = 3;          // what ingest-dem-glo30.ts cached
const DOWNSAMPLE = 2;               // hydrology runs one step coarser
const BBOX = { w: 40, s: -2, e: 52, n: 12 };

const SRC_PPD = 3600 / 2 ** SOURCE_OVERVIEW;
const PPD = SRC_PPD / DOWNSAMPLE;
const W = Math.round((BBOX.e - BBOX.w) * PPD);
const H = Math.round((BBOX.n - BBOX.s) * PPD);
const PIXEL_M = 111_320 / PPD;
const CELL_KM2 = (PIXEL_M / 1000) ** 2;

/**
 * Contributing area above which a cell is a channel.
 *
 * 25 km2. Below that the "streams" are hillside rills that a 494 m grid cannot
 * resolve and a geologist cannot walk to; above it, the features are wadis that
 * appear on a map and carry sediment. It is a choice, so it is recorded on every
 * feature that comes out.
 */
const STREAM_AREA_KM2 = 25;
const STREAM_CELLS = Math.round(STREAM_AREA_KM2 / CELL_KM2);

const ALGORITHM = "priority-flood + D8 + area-threshold";
const ALGORITHM_VERSION = "1.0.0";
const DEM_SOURCE = "Copernicus GLO-30 (AWS Open Data)";

const NODATA = -9000;
const NO_FLOW = 255;

function tileId(lat: number, lng: number): string {
  const ns = lat < 0 ? "S" : "N";
  const ew = lng < 0 ? "W" : "E";
  return `Copernicus_DSM_COG_10_${ns}${String(Math.abs(lat)).padStart(2, "0")}_00_` +
    `${ew}${String(Math.abs(lng)).padStart(3, "0")}_00_DEM`;
}

// ── Mosaic, downsampled ─────────────────────────────────────────────────────

/**
 * The cached tiles, averaged 2x2 into the hydrology grid.
 *
 * Averaging rather than sampling: a nearest-neighbour pick would keep whichever
 * of four pixels happened to be first, and on a 247 m DEM that is enough noise to
 * carve false channels. NaN anywhere in the window makes the output NaN — a cell
 * half in the sea is not land at half elevation.
 */
function buildGrid(): Float32Array {
  const grid = new Float32Array(W * H).fill(NaN);
  let tiles = 0, absent = 0;

  for (let lat = BBOX.s; lat < BBOX.n; lat++) {
    for (let lng = BBOX.w; lng < BBOX.e; lng++) {
      let src: Float32Array;
      try {
        const bytes = Deno.readFileSync(`${CACHE}/${tileId(lat, lng)}.ov${SOURCE_OVERVIEW}.bin`);
        src = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      } catch {
        absent++;
        continue;
      }
      tiles++;
      const side = Math.round(Math.sqrt(src.length));
      const out = side / DOWNSAMPLE;
      const x0 = Math.round((lng - BBOX.w) * PPD);
      const y0 = Math.round((BBOX.n - (lat + 1)) * PPD);

      for (let r = 0; r < out; r++) {
        const gy = y0 + r;
        if (gy < 0 || gy >= H) continue;
        for (let c = 0; c < out; c++) {
          const gx = x0 + c;
          if (gx < 0 || gx >= W) continue;
          let sum = 0, ok = true;
          for (let dr = 0; dr < DOWNSAMPLE && ok; dr++) {
            for (let dc = 0; dc < DOWNSAMPLE; dc++) {
              const v = src[(r * DOWNSAMPLE + dr) * side + (c * DOWNSAMPLE + dc)];
              if (!(v > NODATA)) { ok = false; break; }
              sum += v;
            }
          }
          grid[gy * W + gx] = ok ? sum / (DOWNSAMPLE * DOWNSAMPLE) : NaN;
        }
      }
    }
  }
  console.log(`grid ${W}x${H} @ ${PIXEL_M.toFixed(0)} m — ${tiles} tiles, ${absent} absent (ocean)`);
  if (tiles === 0) {
    console.error(`REFUSED: no cached DEM tiles in ${CACHE}. Run ingest-dem-glo30.ts first.`);
    Deno.exit(3);
  }
  return grid;
}

// ── A binary heap over cell indices, keyed by elevation ─────────────────────
//
// Typed arrays, not objects. Priority-flood pushes and pops every land cell, and
// eight million small objects is a garbage-collection problem rather than an
// algorithm.
class MinHeap {
  private idx: Uint32Array;
  private key: Float32Array;
  private n = 0;

  constructor(capacity: number) {
    this.idx = new Uint32Array(capacity);
    this.key = new Float32Array(capacity);
  }
  get size(): number { return this.n; }

  push(i: number, k: number): void {
    let c = this.n++;
    this.idx[c] = i; this.key[c] = k;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (this.key[p] <= this.key[c]) break;
      this.swap(p, c); c = p;
    }
  }
  pop(): number {
    const top = this.idx[0];
    this.n--;
    if (this.n > 0) {
      this.idx[0] = this.idx[this.n]; this.key[0] = this.key[this.n];
      let p = 0;
      for (;;) {
        const l = 2 * p + 1, r = l + 1;
        let s = p;
        if (l < this.n && this.key[l] < this.key[s]) s = l;
        if (r < this.n && this.key[r] < this.key[s]) s = r;
        if (s === p) break;
        this.swap(s, p); p = s;
      }
    }
    return top;
  }
  private swap(a: number, b: number): void {
    const i = this.idx[a]; this.idx[a] = this.idx[b]; this.idx[b] = i;
    const k = this.key[a]; this.key[a] = this.key[b]; this.key[b] = k;
  }
}

const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];

/**
 * Priority-flood: raise every pit until water can reach an outlet.
 *
 * Without it, flow accumulation stops dead in every hollow the DEM contains —
 * and a 494 m grid contains thousands, most of them noise rather than real
 * endorheic basins. The epsilon keeps a downhill gradient across filled flats so
 * D8 has somewhere to send the water.
 *
 * Outlets are the grid edge AND every land cell touching NaN, which is the coast.
 * Returns the order cells were settled in — increasing elevation — because
 * accumulation needs exactly its reverse and computing it again would mean
 * sorting eight million floats.
 */
function fillDepressions(elev: Float32Array): Uint32Array {
  const closed = new Uint8Array(W * H);
  const order = new Uint32Array(W * H);
  let settled = 0;
  const heap = new MinHeap(W * H);
  const EPS = 1e-4;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (Number.isNaN(elev[i])) { closed[i] = 1; continue; }
      let outlet = x === 0 || y === 0 || x === W - 1 || y === H - 1;
      if (!outlet) {
        for (let d = 0; d < 8; d++) {
          if (Number.isNaN(elev[(y + DY[d]) * W + (x + DX[d])])) { outlet = true; break; }
        }
      }
      if (outlet) { closed[i] = 1; heap.push(i, elev[i]); }
    }
  }
  console.log(`  ${heap.size} outlet cells (edges and coast)`);

  while (heap.size > 0) {
    const i = heap.pop();
    order[settled++] = i;
    const x = i % W, y = (i / W) | 0;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (closed[j]) continue;
      closed[j] = 1;
      // The fill: a neighbour lower than where the water already is gets raised
      // to just above it, so there is always a way out.
      if (elev[j] <= elev[i]) elev[j] = elev[i] + EPS;
      heap.push(j, elev[j]);
    }
  }
  console.log(`  filled, ${settled} land cells settled`);
  return order.subarray(0, settled);
}

/** Steepest descent to one of eight neighbours, or NO_FLOW at an outlet. */
function flowDirections(elev: Float32Array): Uint8Array {
  const dir = new Uint8Array(W * H).fill(NO_FLOW);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const e = elev[i];
      if (Number.isNaN(e)) continue;
      let best = -1, bestDrop = 0;
      for (let d = 0; d < 8; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ne = elev[ny * W + nx];
        if (Number.isNaN(ne)) { best = -1; break; }   // drains to the sea
        // Diagonals cover more ground, so gradient — not raw drop — decides.
        const drop = (e - ne) / (d % 2 === 0 ? 1 : Math.SQRT2);
        if (drop > bestDrop) { bestDrop = drop; best = d; }
      }
      dir[i] = best < 0 ? NO_FLOW : best;
    }
  }
  return dir;
}

/**
 * How many cells drain through each cell.
 *
 * Walked in reverse settle order — highest first — so every cell's own catchment
 * is complete before it passes the total downstream. One pass, no iteration to
 * convergence.
 */
function accumulate(dir: Uint8Array, order: Uint32Array): Uint32Array {
  const acc = new Uint32Array(W * H).fill(1);
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k];
    const d = dir[i];
    if (d === NO_FLOW) continue;
    const x = i % W, y = (i / W) | 0;
    const nx = x + DX[d], ny = y + DY[d];
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    acc[ny * W + nx] += acc[i];
  }
  return acc;
}

// ── Vectorising ─────────────────────────────────────────────────────────────

const lngOf = (x: number) => BBOX.w + (x + 0.5) / PPD;
const latOf = (y: number) => BBOX.n - (y + 0.5) / PPD;

/**
 * Trace channels into polylines by following flow downstream.
 *
 * Each stream cell is used once, so a trunk is one line rather than being
 * re-drawn by every tributary that joins it. A trace stops when it reaches a cell
 * already consumed — which is exactly a confluence — so the network comes out as
 * a set of reaches that meet, not as a mat of overlapping strands.
 */
function traceStreams(acc: Uint32Array, dir: Uint8Array): Array<Array<[number, number]>> {
  const isStream = (i: number) => acc[i] >= STREAM_CELLS;
  const used = new Uint8Array(W * H);
  const lines: Array<Array<[number, number]>> = [];

  // Sources first — a stream cell with no stream cell flowing into it — so traces
  // start at the top of a reach rather than in the middle of one.
  const inflow = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (!isStream(i) || dir[i] === NO_FLOW) continue;
    const x = i % W, y = (i / W) | 0;
    const nx = x + DX[dir[i]], ny = y + DY[dir[i]];
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    inflow[ny * W + nx] = 1;
  }

  const traceFrom = (start: number) => {
    const pts: Array<[number, number]> = [];
    let i = start;
    for (let step = 0; step < 100_000; step++) {
      if (used[i]) { pts.push([lngOf(i % W), latOf((i / W) | 0)]); break; }
      used[i] = 1;
      pts.push([lngOf(i % W), latOf((i / W) | 0)]);
      const d = dir[i];
      if (d === NO_FLOW) break;
      const x = i % W, y = (i / W) | 0;
      const nx = x + DX[d], ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) break;
      const j = ny * W + nx;
      if (!isStream(j)) break;
      i = j;
    }
    if (pts.length >= 2) lines.push(simplify(pts, 0.004));
  };

  for (let i = 0; i < W * H; i++) if (isStream(i) && !inflow[i]) traceFrom(i);
  // Anything left is a loop or an orphan reach; traced so the network is whole.
  for (let i = 0; i < W * H; i++) if (isStream(i) && !used[i]) traceFrom(i);
  return lines;
}

/** Douglas-Peucker. A 494 m trace has a vertex every pixel; the pack does not need them. */
function simplify(pts: Array<[number, number]>, tol: number): Array<[number, number]> {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let far = -1, maxD = tol;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1e-12;
    for (let k = a + 1; k < b; k++) {
      const d = Math.abs((pts[k][0] - ax) * dy - (pts[k][1] - ay) * dx) / len;
      if (d > maxD) { maxD = d; far = k; }
    }
    if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return pts.filter((_, k) => keep[k] === 1);
}

// ── Main ────────────────────────────────────────────────────────────────────

console.log(`hydrology at ${PIXEL_M.toFixed(0)} m — channel threshold ` +
  `${STREAM_AREA_KM2} km2 (${STREAM_CELLS} cells)`);

const elev = buildGrid();
console.log("filling depressions…");
const order = fillDepressions(elev);
console.log("flow directions…");
const dir = flowDirections(elev);
console.log("flow accumulation…");
const acc = accumulate(dir, order);

let streamCells = 0;
for (let i = 0; i < acc.length; i++) if (acc[i] >= STREAM_CELLS && !Number.isNaN(elev[i])) streamCells++;
console.log(`  ${streamCells} channel cells (${(streamCells * CELL_KM2).toFixed(0)} km2 of channel)`);

console.log("vectorising…");
const lines = traceStreams(acc, dir);
const vertices = lines.reduce((a, l) => a + l.length, 0);
console.log(`  ${lines.length} reaches, ${vertices} vertices after simplification`);

if (lines.length < 50) {
  console.error(`REFUSED: only ${lines.length} reaches. A country-scale network should be ` +
    `hundreds; this few means the fill or the threshold is wrong, and shipping it would ` +
    `put a handful of invented lines where a drainage network belongs.`);
  Deno.exit(3);
}

// ── Into the pack ───────────────────────────────────────────────────────────

const bboxOf = (l: Array<[number, number]>): [number, number, number, number] => {
  let w = 180, s = 90, e = -180, n = -90;
  for (const [x, y] of l) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
  return [w, s, e, n];
};

const features: PackMapFeature[] = lines.map((l, i) => ({
  id: `drainage_glo30_${i}`,
  kind: "drainage",
  name: null,
  source: "derived:dem-hydrology",
  // PROVENANCE. This is a derived channel, not a surveyed river, and every field
  // a reader needs to judge it is here.
  attributes: {
    algorithm: ALGORITHM,
    algorithm_version: ALGORITHM_VERSION,
    dem_source: DEM_SOURCE,
    sampling_m: Math.round(PIXEL_M),
    threshold_km2: STREAM_AREA_KM2,
    derived_at: new Date().toISOString(),
  },
  lines: [l],
  bbox: bboxOf(l),
}));

const layersPath = `${PACK}/maplayers.json`;
const layers = JSON.parse(await Deno.readTextFile(layersPath)) as {
  formatVersion: number; kind: string; rows: PackMapFeature[];
};
const kept = layers.rows.filter((r) => r.kind !== "drainage");
console.log(`\nmaplayers: ${kept.length} existing (${layers.rows.length - kept.length} old drainage replaced)` +
  ` + ${features.length} drainage`);
const rows = [...kept, ...features].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

// ── Distance from every terrain cell to the nearest channel ─────────────────
//
// Bucketed by degree so this is not 36,505 x 100,000. The column has been NULL
// since the schema was written, with a comment saying it stays NULL until
// drainage exists rather than becoming a guess. It exists now.
console.log("distance to drainage, per terrain cell…");
const terrainPath = `${PACK}/terrain.json`;
const terrainFile = JSON.parse(await Deno.readTextFile(terrainPath)) as {
  formatVersion: number; kind: string; rows: PackTerrainCell[];
};

const BUCKET = 0.5;
const buckets = new Map<string, Array<[number, number]>>();
const bkey = (lat: number, lng: number) => `${Math.floor(lat / BUCKET)}:${Math.floor(lng / BUCKET)}`;
for (const l of lines) {
  for (const [x, y] of l) {
    const k = bkey(y, x);
    let b = buckets.get(k);
    if (!b) { b = []; buckets.set(k, b); }
    b.push([x, y]);
  }
}

const R = 6371000, rad = (d: number) => (d * Math.PI) / 180;
function haversine(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Search outward a ring of buckets at a time; stop once nothing closer can exist. */
function distanceToDrainage(lat: number, lng: number): number | null {
  const bi = Math.floor(lat / BUCKET), bj = Math.floor(lng / BUCKET);
  let best = Infinity;
  for (let ring = 0; ring <= 4; ring++) {
    for (let di = -ring; di <= ring; di++) {
      for (let dj = -ring; dj <= ring; dj++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== ring) continue;
        const b = buckets.get(`${bi + di}:${bj + dj}`);
        if (!b) continue;
        for (const [x, y] of b) {
          const d = haversine(lat, lng, y, x);
          if (d < best) best = d;
        }
      }
    }
    // A closer point cannot be beyond the rings already searched.
    if (best < ring * BUCKET * 111_320 * 0.5) break;
  }
  return Number.isFinite(best) ? Math.round(best) : null;
}

let withDrainage = 0;
const terrainRows = terrainFile.rows.map((t) => {
  const d = distanceToDrainage(t.lat, t.lng);
  if (d != null) withDrainage++;
  return { ...t, drainageDistM: d };
});
console.log(`  ${withDrainage} of ${terrainRows.length} terrain cells have a channel within reach`);

// ── Write, and keep the manifest honest ─────────────────────────────────────
const layersBody = canonicalJson({ ...layers, rows });
await Deno.writeTextFile(layersPath, layersBody);
const terrainBody = canonicalJson({ ...terrainFile, rows: terrainRows });
await Deno.writeTextFile(terrainPath, terrainBody);

const manifestPath = `${PACK}/${MANIFEST_FILE}`;
const manifest = JSON.parse(await Deno.readTextFile(manifestPath)) as PackManifest;
manifest.files["maplayers.json"] = sha256Hex(layersBody);
manifest.files["terrain.json"] = sha256Hex(terrainBody);
if (manifest.counts) manifest.counts.mapFeatures = rows.length;
manifest.sha256 = sha256Hex(canonicalJson(manifest.files));
await Deno.writeTextFile(manifestPath, canonicalJson(manifest));

console.log(`\nmaplayers.json ${(layersBody.length / 1e6).toFixed(1)} MB, ` +
  `terrain.json ${(terrainBody.length / 1e6).toFixed(1)} MB`);
console.log("\nNEXT: leakage and usefulness, BEFORE this is scored.");
console.log("  npx jest lib/__tests__/prospectivityBaseline.test.ts");

// Raster map tiles — downloaded when there is a signal, kept for when there is not.
//
// THE RULE THIS IMPLEMENTS
// ------------------------
// Never waste a connection, and never depend on one. Online, tiles covering the
// ground around the geologist are fetched and written to disk. Offline, the
// same call returns whatever is already on disk. The map does not know or care
// which happened — it is handed local file URIs either way, so imagery appearing
// or not appearing never changes how the map behaves.
//
// The geological knowledge is NOT affected by any of this. Units, faults,
// occurrences and terrain come from the offline pack in both cases. Imagery is
// a backdrop; losing it costs context, never guidance.
//
// WHY FOUR SOURCES AND NOT ONE
// ----------------------------
// Satellite imagery alone answers "what does this ground look like" and nothing
// else: no town has a name on it, no track is distinguishable from a dry
// watercourse, and a geologist who cannot say which village they are near
// cannot describe a find to anyone. So the backdrop is composed:
//
//   imagery    what the ground looks like
//   hillshade  what shape it is, where the DEM pack is too coarse to say
//   roads      how to get there
//   labels     where "there" is — countries, regions, towns, villages
//
// Each is an independent layer that is fetched ONLY while it is switched on, so
// turning labels off is a real saving on a metered link rather than a cosmetic
// toggle. All four are tiled the same way and cached the same way; the only
// difference is the URL and how they are painted.
//
// SOURCE
//   Esri's public ArcGIS map services. Attribution is required and is displayed
//   on the map, which is why ATTRIBUTION is exported rather than left as a
//   comment.
import * as FileSystem from "expo-file-system";
import { withTimeout } from "../withTimeout";

export const ATTRIBUTION = "Imagery © Esri, Maxar, Earthstar Geographics";

/**
 * THE ROOT CAUSE, CONFIRMED ON DEVICE. FileSystem.downloadAsync() carries no
 * timeout of its own, and unlike the four Supabase calls already bounded
 * (lib/auth.tsx, lib/appUpdate.ts, lib/sync/pushOutbox.ts, pullAnalysis.ts,
 * pushPhotos.ts), it is reached only when a raster layer is actually on —
 * which is exactly why the freeze correlated with satellite/roads/labels and
 * not with the others. A/B'd on the device: those three OFF, cold start after
 * cold start, never froze; back on, it did. One worker stuck on one stalled
 * tile blocks that whole downloadMissing() pass — see the worker loop below —
 * and CONCURRENCY workers each awaiting their own unbounded download is a lot
 * of surface area for exactly one to stall.
 */
export const TILE_DOWNLOAD_TIMEOUT_MS = 10_000;
/** Distinguishable from any real FileSystem.DownloadResult. */
const TIMED_OUT = Symbol("tile download timed out");

/** Which backdrop a tile belongs to. Each is cached and toggled independently. */
export type TileSourceId = "imagery" | "hillshade" | "roads" | "labels";

interface TileSource {
  id: TileSourceId;
  template: string;
  /** Past this the service has no tiles; asking anyway returns 404s all day. */
  maxZoom: number;
  ext: "jpg" | "png";
  /** True when the tile has transparency and must be painted over the base. */
  overlay: boolean;
}

const SOURCES: Record<TileSourceId, TileSource> = {
  imagery: {
    id: "imagery",
    template: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    maxZoom: 17,
    ext: "jpg",
    overlay: false,
  },
  hillshade: {
    id: "hillshade",
    template: "https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}",
    maxZoom: 15,
    ext: "jpg",
    overlay: false,
  },
  roads: {
    id: "roads",
    template: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
    maxZoom: 17,
    ext: "png",
    overlay: true,
  },
  labels: {
    id: "labels",
    template: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    maxZoom: 16,
    ext: "png",
    overlay: true,
  },
};

export const TILE_SOURCE_IDS = Object.keys(SOURCES) as TileSourceId[];

export const isOverlaySource = (id: TileSourceId): boolean => SOURCES[id].overlay;

const DIR = `${FileSystem.cacheDirectory}sat-tiles/`;

/**
 * How much disk the whole backdrop may occupy.
 *
 * Four sources over a country's worth of traverse would grow without bound, and
 * a field phone that runs out of storage stops taking photographs — which is a
 * far worse failure than a missing tile. Oldest-first pruning keeps the ground
 * most recently walked over and gives up the rest.
 */
export const CACHE_BUDGET_BYTES = 220 * 1024 * 1024;

export interface Tile {
  z: number;
  x: number;
  y: number;
  /** Geographic box of the tile, for drawing. */
  w: number; s: number; e: number; n: number;
}

export interface CachedTile extends Tile {
  uri: string;
  source: TileSourceId;
}

// ── Web Mercator tile maths ─────────────────────────────────────────────────

const lngToX = (lng: number, z: number) => Math.floor(((lng + 180) / 360) * 2 ** z);
const latToY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};
const xToLng = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const yToLat = (y: number, z: number) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

/**
 * Zoom whose tiles are about the right size for a view of this radius.
 *
 * Capped at 16: past that the tile count for a walkable area grows faster than
 * a field connection can deliver, and the extra detail is not what anyone is
 * navigating by.
 */
export function zoomFor(radiusM: number): number {
  const spanM = radiusM * 2;
  // A tile is ~256 px; aim for roughly four tiles across the view.
  const metresPerTile = spanM / 4;
  const z = Math.round(Math.log2((40_075_017 * Math.cos(0)) / metresPerTile / 256) + 8);
  return Math.max(6, Math.min(16, z));
}

/** Ground resolution of one Web Mercator pixel at the equator, zoom 0. */
const EQUATOR_MPP_Z0 = 156_543.03392;

/**
 * The zoom whose pixels match what the camera is actually showing.
 *
 * This is what makes labels legible. A fixed zoom chosen from the session's
 * initial radius means that zooming in to read a village name enlarges a
 * blurred tile instead of fetching a sharper one, and zooming out to plan a
 * 90 km drive downloads hundreds of street-level tiles nobody can see. Deriving
 * it from metres-per-pixel keeps tile detail and screen detail in step, which
 * is also what makes label DENSITY behave: the services publish fewer names at
 * low zoom, which is exactly the behaviour a field map should have.
 */
export function zoomForResolution(metresPerPx: number, lat: number, source?: TileSourceId): number {
  if (!Number.isFinite(metresPerPx) || metresPerPx <= 0) return 12;
  const cos = Math.max(0.05, Math.cos((lat * Math.PI) / 180));
  const z = Math.round(Math.log2((EQUATOR_MPP_Z0 * cos) / metresPerPx));
  const max = source ? SOURCES[source].maxZoom : 17;
  return Math.max(3, Math.min(max, z));
}

/** Tiles covering a box, in the order they should be fetched (centre outward). */
export function tilesFor(
  bbox: [number, number, number, number],
  z: number,
  max = 48,
): Tile[] {
  const x0 = lngToX(bbox[0], z), x1 = lngToX(bbox[2], z);
  const y0 = latToY(bbox[3], z), y1 = latToY(bbox[1], z);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;

  const out: Tile[] = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      out.push({
        z, x, y,
        w: xToLng(x, z), e: xToLng(x + 1, z),
        n: yToLat(y, z), s: yToLat(y + 1, z),
      });
    }
  }
  // Centre first, so a slow link fills in what the geologist is looking at
  // before it fills in the corners.
  out.sort((a, b) => (a.x - cx) ** 2 + (a.y - cy) ** 2 - ((b.x - cx) ** 2 + (b.y - cy) ** 2));
  return out.slice(0, max);
}

/**
 * Grow a box by a fraction of its own size.
 *
 * The map is used while WALKING, so the ground about to be needed is the ground
 * just off the edge of the screen. Fetching a margin around the view means the
 * next hundred metres are already on disk by the time they are on screen, and
 * the geologist never watches a tile load in front of them.
 */
export function padBbox(
  bbox: [number, number, number, number],
  fraction: number,
): [number, number, number, number] {
  const dx = (bbox[2] - bbox[0]) * fraction;
  const dy = (bbox[3] - bbox[1]) * fraction;
  return [
    Math.max(-180, bbox[0] - dx), Math.max(-85, bbox[1] - dy),
    Math.min(180, bbox[2] + dx), Math.min(85, bbox[3] + dy),
  ];
}

// ── Disk ────────────────────────────────────────────────────────────────────

const pathOf = (t: Tile, source: TileSourceId) =>
  `${DIR}${source}_${t.z}_${t.x}_${t.y}.${SOURCES[source].ext}`;

let dirReady: Promise<void> | null = null;
function ensureDir(): Promise<void> {
  dirReady ??= FileSystem.makeDirectoryAsync(DIR, { intermediates: true })
    .catch(() => {
      // Already there, or the cache directory is unavailable. Either way the
      // per-tile writes below fail harmlessly and the map runs without imagery.
    });
  return dirReady;
}

/**
 * Which tiles are known to be on disk.
 *
 * A memo over `getInfoAsync`, which is a real filesystem round trip per tile and
 * was being paid on every scene change for every tile of every source — several
 * hundred stat calls while a finger was on the map. The set only grows through
 * this module, so it can be trusted once populated.
 */
const known = new Set<string>();
const missing = new Set<string>();

async function onDisk(t: Tile, source: TileSourceId): Promise<string | null> {
  const p = pathOf(t, source);
  if (known.has(p)) return p;
  if (missing.has(p)) return null;
  try {
    const info = await FileSystem.getInfoAsync(p);
    // A zero-byte file is a failed download, not a tile; treat it as absent so
    // it gets another attempt rather than rendering as a black square forever.
    if (info.exists && (info.size ?? 0) > 0) { known.add(p); return p; }
    missing.add(p);
    return null;
  } catch {
    return null;
  }
}

/**
 * Tiles already available for this box, without touching the network.
 *
 * Called on every scene change, including offline, and always resolves.
 */
export async function cachedTiles(
  bbox: [number, number, number, number],
  z: number,
  source: TileSourceId = "imagery",
  max = 48,
): Promise<CachedTile[]> {
  await ensureDir();
  const wanted = tilesFor(bbox, z, max);
  const found = await Promise.all(
    wanted.map(async (t) => {
      const uri = await onDisk(t, source);
      return uri ? { ...t, uri, source } : null;
    }),
  );
  return found.filter((t): t is CachedTile => t !== null);
}

/**
 * How many tiles are fetched at once.
 *
 * A field link is latency-bound rather than bandwidth-bound: a 256×256 tile is
 * tens of kilobytes and the round trip is most of the wait, so a handful in
 * flight finishes a screenful several times sooner than a strict queue while
 * still being gentle on a weak cell. Small on purpose — this runs beside a live
 * GPS session, not instead of one.
 */
const CONCURRENCY = 4;

/**
 * Fetch whatever is missing.
 *
 * `onProgress` fires as each tile lands so the map can show imagery as it
 * arrives instead of after the lot.
 */
export async function downloadMissing(
  bbox: [number, number, number, number],
  z: number,
  source: TileSourceId = "imagery",
  opts: { signal?: { cancelled: boolean }; onProgress?: (t: CachedTile) => void; max?: number } = {},
): Promise<number> {
  await ensureDir();
  const queue = tilesFor(bbox, z, opts.max ?? 48);
  let next = 0;
  let written = 0;
  let stopped = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stopped || opts.signal?.cancelled) return;
      const t = queue[next++];
      if (!t) return;
      if (await onDisk(t, source)) continue;
      const path = pathOf(t, source);
      const url = SOURCES[source].template
        .replace("{z}", String(t.z))
        .replace("{x}", String(t.x))
        .replace("{y}", String(t.y));
      try {
        // A stalled connection to Esri neither resolves nor rejects
        // downloadAsync at all — no timeout of its own, see
        // TILE_DOWNLOAD_TIMEOUT_MS above. Raced against a ceiling so ONE
        // stuck tile cannot hold this worker, and every worker behind it in
        // the queue, for the rest of the session. The map draws whatever the
        // pack and the disk cache already have regardless — this only
        // decides how long a fresh tile is worth waiting for.
        const res = await withTimeout<FileSystem.FileSystemDownloadResult | typeof TIMED_OUT>(
          FileSystem.downloadAsync(url, path),
          TILE_DOWNLOAD_TIMEOUT_MS,
          TIMED_OUT,
        );
        if (res === TIMED_OUT || res.status !== 200) {
          // Leave nothing behind that would later look like a valid tile —
          // downloadAsync may still be writing to `path` in the background
          // after a timeout, so this is best-effort, not a guarantee; onDisk()
          // below independently checks the file is actually complete before
          // ever treating it as cached.
          await FileSystem.deleteAsync(path, { idempotent: true }).catch(() => {});
          missing.add(path);
          continue;
        }
        missing.delete(path);
        known.add(path);
        written++;
        opts.onProgress?.({ ...t, uri: path, source });
      } catch {
        // Signal lost mid-traverse. Stop asking; the pack still runs the session.
        stopped = true;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return written;
}

/** Bytes currently held, for a settings screen to show and offer to clear. */
export async function cacheSize(): Promise<number> {
  try {
    const names = await FileSystem.readDirectoryAsync(DIR);
    const sizes = await Promise.all(
      names.map(async (n) => {
        const i = await FileSystem.getInfoAsync(DIR + n);
        return i.exists ? i.size ?? 0 : 0;
      }),
    );
    return sizes.reduce((a, b) => a + b, 0);
  } catch {
    return 0;
  }
}

/**
 * Drop the oldest tiles once the cache exceeds its budget.
 *
 * Best-effort and never throws: a phone that cannot prune its cache should
 * still run a field session.
 */
export async function pruneCache(budgetBytes = CACHE_BUDGET_BYTES): Promise<number> {
  try {
    const names = await FileSystem.readDirectoryAsync(DIR);
    const files = await Promise.all(
      names.map(async (n) => {
        const i = await FileSystem.getInfoAsync(DIR + n);
        return { path: DIR + n, size: i.exists ? i.size ?? 0 : 0, at: (i.exists && i.modificationTime) || 0 };
      }),
    );
    let total = files.reduce((a, f) => a + f.size, 0);
    if (total <= budgetBytes) return 0;
    files.sort((a, b) => a.at - b.at);
    let removed = 0;
    for (const f of files) {
      if (total <= budgetBytes) break;
      await FileSystem.deleteAsync(f.path, { idempotent: true }).catch(() => {});
      known.delete(f.path);
      missing.delete(f.path);
      total -= f.size;
      removed++;
    }
    return removed;
  } catch {
    return 0;
  }
}

export async function clearCache(): Promise<void> {
  await FileSystem.deleteAsync(DIR, { idempotent: true }).catch(() => {});
  dirReady = null;
  known.clear();
  missing.clear();
}

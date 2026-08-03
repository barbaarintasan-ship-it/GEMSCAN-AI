// Satellite imagery — downloaded when there is a signal, kept for when there is not.
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
// SOURCE
//   Esri World Imagery, a public tile service. Attribution is required and is
//   displayed on the map, which is why ATTRIBUTION is exported rather than left
//   as a comment.
import * as FileSystem from "expo-file-system";

export const ATTRIBUTION = "Imagery © Esri, Maxar, Earthstar Geographics";

const TEMPLATE =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

const DIR = `${FileSystem.cacheDirectory}sat-tiles/`;

export interface Tile {
  z: number;
  x: number;
  y: number;
  /** Geographic box of the tile, for drawing. */
  w: number; s: number; e: number; n: number;
}

export interface CachedTile extends Tile {
  uri: string;
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

// ── Disk ────────────────────────────────────────────────────────────────────

const pathOf = (t: Tile) => `${DIR}${t.z}_${t.x}_${t.y}.jpg`;

let dirReady: Promise<void> | null = null;
function ensureDir(): Promise<void> {
  dirReady ??= FileSystem.makeDirectoryAsync(DIR, { intermediates: true })
    .catch(() => {
      // Already there, or the cache directory is unavailable. Either way the
      // per-tile writes below fail harmlessly and the map runs without imagery.
    });
  return dirReady;
}

async function onDisk(t: Tile): Promise<string | null> {
  const p = pathOf(t);
  try {
    const info = await FileSystem.getInfoAsync(p);
    // A zero-byte file is a failed download, not a tile; treat it as absent so
    // it gets another attempt rather than rendering as a black square forever.
    return info.exists && (info.size ?? 0) > 0 ? p : null;
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
): Promise<CachedTile[]> {
  await ensureDir();
  const wanted = tilesFor(bbox, z);
  const found = await Promise.all(
    wanted.map(async (t) => {
      const uri = await onDisk(t);
      return uri ? { ...t, uri } : null;
    }),
  );
  return found.filter((t): t is CachedTile => t !== null);
}

/**
 * Fetch whatever is missing, one at a time.
 *
 * Sequential on purpose: a field connection is usually a single weak cellular
 * link, and eight parallel downloads over it finish later than eight
 * sequential ones while making the app feel worse. `onProgress` fires after
 * each tile so the map can show imagery as it lands instead of after the lot.
 */
export async function downloadMissing(
  bbox: [number, number, number, number],
  z: number,
  opts: { signal?: { cancelled: boolean }; onProgress?: (t: CachedTile) => void } = {},
): Promise<number> {
  await ensureDir();
  let written = 0;
  for (const t of tilesFor(bbox, z)) {
    if (opts.signal?.cancelled) break;
    if (await onDisk(t)) continue;
    const url = TEMPLATE.replace("{z}", String(t.z)).replace("{x}", String(t.x)).replace("{y}", String(t.y));
    try {
      const res = await FileSystem.downloadAsync(url, pathOf(t));
      if (res.status !== 200) {
        // Leave nothing behind that would later look like a valid tile.
        await FileSystem.deleteAsync(pathOf(t), { idempotent: true }).catch(() => {});
        continue;
      }
      written++;
      opts.onProgress?.({ ...t, uri: pathOf(t) });
    } catch {
      // Signal lost mid-traverse. Stop asking; the pack still runs the session.
      break;
    }
  }
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

export async function clearCache(): Promise<void> {
  await FileSystem.deleteAsync(DIR, { idempotent: true }).catch(() => {});
  dirReady = null;
}

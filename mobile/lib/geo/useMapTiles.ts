// The raster backdrop for the current VIEW, online or off.
//
// One hook, one behaviour: show what is on disk immediately, and if there is a
// connection, quietly fetch what is missing and show that too as it arrives.
// The caller never asks which mode it is in, because there is no mode — this is
// what "the transition must be seamless" means in code.
//
// WHAT CHANGED, AND WHY IT MATTERS IN THE FIELD
// --------------------------------------------
// This used to be driven by the SESSION's initial radius: one zoom level chosen
// once, for the whole traverse. Zooming in to read a village name enlarged a
// blurry tile instead of fetching a sharp one, and zooming out to plan a drive
// asked for street-level tiles by the hundred. Now it follows the camera, so
// tile detail tracks screen detail — which is also what gives label density its
// zoom behaviour, because the services publish fewer names at lower zooms.
//
// Work is debounced and keyed to a QUANTISED viewport, so a pan of a few metres
// or a pinch that settles back where it started causes no filesystem or network
// work at all. Nothing here runs during a gesture.
import { useEffect, useRef, useState } from "react";
import {
  cachedTiles, downloadMissing, isOverlaySource, padBbox, pruneCache,
  zoomForResolution, type CachedTile, type TileSourceId,
} from "./tileCache";

export interface MapViewport {
  /** What the screen currently covers, in geographic degrees. */
  bbox: [number, number, number, number];
  /** Ground resolution of one screen pixel — what picks the tile zoom. */
  metresPerPx: number;
}

/** Ground fetched beyond the edge of the screen, as a fraction of the view. */
const PREFETCH_MARGIN = 0.35;

/** How long the camera must be still before tiles are asked for. */
const SETTLE_MS = 320;

/** Ceiling per source per view. A screenful with margin is well inside this. */
const MAX_TILES = 60;

/**
 * How often newly downloaded tiles are published to React.
 *
 * Each publish costs a full workspace re-render, two JSON serialisations and a
 * canvas repaint of every tile drawn so far. At four per second the backdrop
 * still visibly fills in; at one per tile the app stopped answering.
 */
const TILE_FLUSH_MS = 250;

export interface MapTiles {
  /** Painted UNDER the geology: imagery, hillshade. */
  base: CachedTile[];
  /** Painted OVER it: roads, labels — they exist to be read, not shaded. */
  overlay: CachedTile[];
  downloading: boolean;
}

const EMPTY: MapTiles = { base: [], overlay: [], downloading: false };

/**
 * A stable key for "the same view".
 *
 * Quantised deliberately: the bbox is rounded to about a hundred metres and the
 * resolution to a zoom step, so walking forward does not re-run the whole
 * pipeline every second while a genuine zoom or a real move does.
 */
function viewKey(v: MapViewport | null, sources: string): string {
  if (!v) return "";
  const q = (n: number) => (Math.round(n * 1000) / 1000).toFixed(3);
  const z = Math.round(Math.log2(Math.max(1e-6, v.metresPerPx)) * 2) / 2;
  return `${v.bbox.map(q).join(",")}|${z}|${sources}`;
}

export function useMapTiles(
  view: MapViewport | null,
  enabled: Partial<Record<TileSourceId, boolean>>,
  isOnline: boolean,
): MapTiles {
  const [tiles, setTiles] = useState<MapTiles>(EMPTY);
  // Lets an in-flight download for an abandoned view stop at the next tile
  // instead of finishing work nobody is looking at.
  const job = useRef<{ cancelled: boolean } | null>(null);

  const active = (Object.keys(enabled) as TileSourceId[]).filter((k) => enabled[k]).sort();
  const key = viewKey(view, active.join("+"));

  useEffect(() => {
    if (job.current) job.current.cancelled = true;

    if (!view || active.length === 0) {
      setTiles((prev) => (prev === EMPTY ? prev : EMPTY));
      return;
    }

    const signal = { cancelled: false };
    job.current = signal;

    const bbox = padBbox(view.bbox, PREFETCH_MARGIN);
    const lat = (view.bbox[1] + view.bbox[3]) / 2;

    const timer = setTimeout(() => {
      void (async () => {
        // Disk first, always. Offline this is the whole answer; online it is
        // what fills the screen while the network catches up.
        const found: CachedTile[] = [];
        for (const source of active) {
          const z = zoomForResolution(view.metresPerPx, lat, source);
          const have = await cachedTiles(bbox, z, source, MAX_TILES);
          if (signal.cancelled) return;
          found.push(...have);
        }
        if (signal.cancelled) return;
        setTiles({ ...split(found), downloading: false });

        if (!isOnline) return;
        setTiles((t) => ({ ...t, downloading: true }));

        // Tiles land in here and are published in batches.
        const arrived: CachedTile[] = [];
        let flushTimer: ReturnType<typeof setTimeout> | null = null;
        const flush = () => {
          flushTimer = null;
          if (signal.cancelled || arrived.length === 0) return;
          const batch = arrived.splice(0, arrived.length);
          setTiles((prev) => {
            const all = [...prev.base, ...prev.overlay];
            const seen = new Set(all.map((p) => p.uri));
            let added = false;
            for (const t of batch) {
              if (seen.has(t.uri)) continue;
              seen.add(t.uri);
              all.push(t);
              added = true;
            }
            // Returning `prev` unchanged matters: an all-duplicate batch must not
            // manufacture a re-render of its own.
            return added ? { ...split(all), downloading: prev.downloading } : prev;
          });
        };
        const scheduleFlush = () => {
          if (flushTimer == null) flushTimer = setTimeout(flush, TILE_FLUSH_MS);
        };
        const stopFlushing = () => {
          if (flushTimer != null) { clearTimeout(flushTimer); flushTimer = null; }
        };

        // Base imagery first: a labelled map with no ground under it is worse
        // to look at than ground with no labels yet.
        for (const source of active) {
          const z = zoomForResolution(view.metresPerPx, lat, source);
          await downloadMissing(bbox, z, source, {
            signal,
            max: MAX_TILES,
            // COLLECTED, then published on a clock. Not per tile.
            //
            // Publishing every  arrival re-rendered the whole workspace, re-serialised
            // both tile lists, injected them into the WebView and made the canvas
            // repaint every tile it had so far — on top of 24 000 geology
            // vertices. Sixty tiles therefore cost sixty redraws of an
            // ever-growing scene: quadratic work on the JS thread, and the app
            // froze solid while imagery downloaded. That is the intermittent
            // stall, and it appeared only when panning to new ground with a
            // signal, which is why it looked random.
            //
            // The backdrop still builds up under the geologist — just at
            // TILE_FLUSH_MS rather than as fast as the network can land packets.
            onProgress: (t) => {
              if (signal.cancelled) return;
              arrived.push(t);
              scheduleFlush();
            },
          });
          if (signal.cancelled) return;
        }
        stopFlushing();
        flush();
        if (!signal.cancelled) setTiles((t) => ({ ...t, downloading: false }));
        // Only after a fetch, and never on the gesture path: a phone that runs
        // out of storage stops taking photographs.
        void pruneCache();
      })();
    }, SETTLE_MS);

    return () => { signal.cancelled = true; clearTimeout(timer); };
    // `key` stands in for the viewport and the enabled set: an identical view
    // arriving as a fresh object is the same ground and must not restart work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, isOnline]);

  return tiles;
}

function split(all: CachedTile[]): { base: CachedTile[]; overlay: CachedTile[] } {
  const base: CachedTile[] = [];
  const overlay: CachedTile[] = [];
  for (const t of all) (isOverlaySource(t.source) ? overlay : base).push(t);
  // Hillshade over imagery, roads under labels — the order each pair is meant
  // to be read in.
  const rank: Record<TileSourceId, number> = { imagery: 0, hillshade: 1, roads: 0, labels: 1 };
  base.sort((a, b) => rank[a.source] - rank[b.source]);
  overlay.sort((a, b) => rank[a.source] - rank[b.source]);
  return { base, overlay };
}

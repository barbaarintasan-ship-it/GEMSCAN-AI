// Satellite imagery for the current scene, online or off.
//
// One hook, one behaviour: show what is on disk immediately, and if there is a
// connection, quietly fetch what is missing and show that too as it arrives.
// The caller never asks which mode it is in, because there is no mode — this is
// what "the transition must be seamless" means in code.
import { useEffect, useRef, useState } from "react";
import { cachedTiles, downloadMissing, zoomFor, type CachedTile } from "./tileCache";

export function useSatelliteTiles(
  bbox: [number, number, number, number] | null,
  radiusM: number,
  enabled: boolean,
  isOnline: boolean,
): { tiles: CachedTile[]; downloading: boolean } {
  const [tiles, setTiles] = useState<CachedTile[]>([]);
  const [downloading, setDownloading] = useState(false);
  // Lets an in-flight download for an abandoned scene stop at the next tile
  // instead of finishing work nobody is looking at.
  const job = useRef<{ cancelled: boolean } | null>(null);

  const key = bbox ? bbox.map((n) => n.toFixed(4)).join(",") : "";

  useEffect(() => {
    job.current?.cancelled === false && (job.current.cancelled = true);
    if (!bbox || !enabled) { setTiles([]); setDownloading(false); return; }

    const signal = { cancelled: false };
    job.current = signal;
    const z = zoomFor(radiusM);
    let alive = true;

    void (async () => {
      // Disk first, always. Offline this is the whole answer; online it is what
      // fills the screen while the network catches up.
      const have = await cachedTiles(bbox, z);
      if (!alive || signal.cancelled) return;
      setTiles(have);

      if (!isOnline) return;
      setDownloading(true);
      await downloadMissing(bbox, z, {
        signal,
        onProgress: (t) => {
          if (!alive || signal.cancelled) return;
          // Append as each lands, so imagery builds up under the geologist
          // rather than appearing all at once at the end.
          setTiles((prev) => (prev.some((p) => p.uri === t.uri) ? prev : [...prev, t]));
        },
      });
      if (alive && !signal.cancelled) setDownloading(false);
    })();

    return () => { alive = false; signal.cancelled = true; };
    // `key` stands in for bbox: a fresh array with identical numbers is the same
    // ground and must not restart the download.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, radiusM, enabled, isOnline]);

  return { tiles, downloading };
}

// Finding the terrain cell under your feet, in constant time.
//
// WHY THIS EXISTS. `terrainAt` scanned every terrain row and kept the nearest.
// With the 2,191 occurrence-biased cells the old pack shipped, that was 2,191
// distance calculations per call and nobody noticed. The independent Copernicus
// DEM produces 254,623 cells covering the whole country — and the same linear
// scan, called once per candidate in a 19-cell k-ring on every recompute, is
// nearly five million haversines per targeting run.
//
// This is the shape of the bug that froze the app once already: work that is
// invisible at small N and fatal at large N, on the one thread that answers
// buttons. It is fixed before the data lands rather than after.
//
// THE FIX IS FREE, because terrain cells ARE H3 cells. The cell containing a
// point is computed directly from the coordinates, so the lookup is a Map hit.
// Only when that cell has no row — a gap in coverage, or the sea — does it widen
// to the surrounding rings, and even then it examines a handful of candidates
// rather than a quarter of a million.
import { cellFor, kRing, resolutionOf, H3_RESOLUTION } from "./h3";
import { haversineM } from "../../../shared/geo-core/geo/spatial";
import type { PackTerrainCell } from "../../../shared/geo-core/pack/types";

export interface TerrainIndex {
  /** The cell containing the point, or the nearest within `maxM`. */
  nearest(lat: number, lng: number, maxM: number): (PackTerrainCell & { fromM: number }) | null;
  size: number;
}

/**
 * How far out to widen when the containing cell has no row.
 *
 * Two rings at H3 resolution 7 reach roughly 5 km, which matches the range over
 * which a DEM cell can still honestly claim to describe the ground someone is
 * standing on. Beyond that the answer is "no terrain here", which is a real
 * answer and better than a reading from 30 km away.
 */
const SEARCH_RINGS = 2;

export function buildTerrainIndex(cells: readonly PackTerrainCell[]): TerrainIndex {
  const byCell = new Map<string, PackTerrainCell>();

  // The key is the row's own `cell`, which pack data always carries — the ingest
  // script computes it with the same library at the same resolution, and it is
  // the primary key of geo.terrain_cell.
  //
  // Unless it does not match the coordinates. A row whose id disagrees with its
  // own position would index under a cell nobody ever queries, and every lookup
  // there would quietly return nothing — the exact silent failure this codebase
  // has been bitten by before. One row is checked; if it disagrees, keys are
  // derived from the coordinates instead, which is slower and always right.
  //
  // The RESOLUTION comes from the data, not from a constant. Terrain runs at 6
  // while the engine runs at 7, so a query keyed at the engine's resolution would
  // look up cells nobody ever stored.
  // Rows without a usable cell id — a fixture, or a corrupted row — are keyed
  // from their coordinates at the engine's own resolution, which is the only
  // resolution anything else in the app queries at.
  const first = cells[0];
  const res = (first ? resolutionOf(first.cell) : null) ?? H3_RESOLUTION;
  const trustIds = !!first && first.cell === cellFor(first.lat, first.lng, res);
  for (const c of cells) byCell.set(trustIds ? c.cell : cellFor(c.lat, c.lng, res), c);

  return {
    size: byCell.size,
    nearest(lat, lng, maxM) {
      if (byCell.size === 0) return null;

      const here = cellFor(lat, lng, res);
      const exact = byCell.get(here);
      if (exact) {
        const d = haversineM({ lat, lng }, { lat: exact.lat, lng: exact.lng });
        // The containing cell always wins, even if its centre is further away
        // than a neighbour's: it is the ground the point is actually on.
        if (d <= maxM) return { ...exact, fromM: d };
      }

      let best: (PackTerrainCell & { fromM: number }) | null = null;
      for (const cell of kRing(here, SEARCH_RINGS)) {
        const c = byCell.get(cell);
        if (!c) continue;
        const d = haversineM({ lat, lng }, { lat: c.lat, lng: c.lng });
        if (d > maxM) continue;
        if (!best || d < best.fromM) best = { ...c, fromM: d };
      }
      return best;
    },
  };
}

/**
 * One index per terrain array, built on first use.
 *
 * Keyed on the array itself, so a replaced pack gets a fresh index and a k-ring
 * of nineteen candidate cells does not rebuild it nineteen times.
 */
const cache = new WeakMap<object, TerrainIndex>();

export function terrainIndexFor(cells: readonly PackTerrainCell[]): TerrainIndex {
  const key = cells as unknown as object;
  let idx = cache.get(key);
  if (!idx) { idx = buildTerrainIndex(cells); cache.set(key, idx); }
  return idx;
}

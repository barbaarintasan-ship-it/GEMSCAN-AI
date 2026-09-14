// H3 cell key for GeoContext caching (computed app-side; the DB stores it as text —
// there is no h3-pg extension). Regional resolution ~7 (≈5 km hexagons) suits
// geological-context caching.
//
// cellCentre/kRing/childrenOf/resolutionOf added for Solo→Team shared-targeting
// Phase 1 — TargetingEngine/hotspotIn (shared/geo-core/gie/) need these to run
// server-side. Same h3-js version (4.1.0) as mobile/lib/geo/h3.ts, same
// H3_RESOLUTION constant — this is the established "shared contract,
// per-runtime transport" split (see shared/geo-core/geo/h3.ts's own header
// note), not a second algorithm: both bindings call the identical library.
import {
  latLngToCell, cellToLatLng, gridDisk, cellToChildren, getResolution, cellToBoundary,
} from "https://esm.sh/h3-js@4.1.0";

// The resolution is shared with the mobile runtime — one constant, two bindings.
export { H3_RESOLUTION } from "../../../../shared/geo-core/geo/h3.ts";
import { H3_RESOLUTION } from "../../../../shared/geo-core/geo/h3.ts";

export function cellFor(lat: number, lng: number, res: number = H3_RESOLUTION): string {
  return latLngToCell(lat, lng, res);
}

/** Cell centre — used to give a target cell a position to walk toward. */
export function cellCentre(cell: string): { lat: number; lng: number } {
  const [lat, lng] = cellToLatLng(cell);
  return { lat, lng };
}

/** The current cell plus its neighbours out to `rings` — the targeting search space. */
export function kRing(cell: string, rings: number): string[] {
  return gridDisk(cell, rings);
}

export function resolutionOf(cell: string): number | null {
  try {
    const r = getResolution(cell);
    return Number.isInteger(r) && r >= 0 && r <= 15 ? r : null;
  } catch {
    return null;
  }
}

/** The finer cells that tile this one — the sample points for a hotspot search. */
export function childrenOf(cell: string, finerBy = 2): string[] {
  const res = resolutionOf(cell);
  if (res == null) return [];
  return cellToChildren(cell, Math.min(15, res + finerBy));
}

/**
 * A cell's hexagon boundary as a closed GeoJSON ring ([lng, lat] pairs, first
 * point repeated last) — added for Phase 2 (AI Recommended Area), which
 * builds an exploration_area polygon from a target cell's own k-ring.
 */
export function cellBoundaryRing(cell: string): [number, number][] {
  return cellToBoundary(cell, true) as [number, number][];
}

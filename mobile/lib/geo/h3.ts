// H3 binding for the device.
//
// The server's geocontext/h3.ts loads h3-js from esm.sh, a URL specifier Metro
// cannot resolve. Rather than share the binding, both runtimes share the
// RESOLUTION — the parity-critical part — and each brings its own h3-js.
// Both are pinned to 4.1.0, so latLngToCell agrees on cell ids.
import { latLngToCell, gridDisk, cellToLatLng, cellToChildren, getResolution } from "h3-js";

import { H3_RESOLUTION } from "../../../shared/geo-core/geo/h3.ts";

export { H3_RESOLUTION };

export function cellFor(lat: number, lng: number, res: number = H3_RESOLUTION): string {
  return latLngToCell(lat, lng, res);
}

/** Cell centre — used to give a target cell a position to walk toward (E4). */
export function cellCentre(cell: string): { lat: number; lng: number } {
  const [lat, lng] = cellToLatLng(cell);
  return { lat, lng };
}

/** The current cell plus its neighbours out to `rings` — the targeting search space. */
export function kRing(cell: string, rings: number): string[] {
  return gridDisk(cell, rings);
}

/**
 * The resolution a cell id was created at.
 *
 * Not every layer runs at the engine's resolution. Terrain is deliberately
 * coarser — resolution 6, 36 km2 — because at 7 the country needs 254,623 rows
 * and Metro turns pack JSON into live objects at startup, which took the app from
 * 297 MB to 588 MB. An index that assumed one resolution would look up cells
 * nobody stored and quietly find nothing.
 */
/**
 * The finer cells that tile this one — the sample points for a hotspot search.
 *
 * Two resolutions down is 49 children, each about a tenth of a square kilometre.
 * That is fine enough to point a geologist at a part of the outcrop and coarse
 * enough that scoring them all is one ranking's worth of work.
 */
export function childrenOf(cell: string, finerBy = 2): string[] {
  const res = resolutionOf(cell);
  if (res == null) return [];
  return cellToChildren(cell, Math.min(15, res + finerBy));
}

export function resolutionOf(cell: string): number | null {
  // h3-js throws on anything that is not a cell id. A pack row always carries a
  // real one; a test fixture or a corrupted row may not, and a thrown error here
  // would take out the whole index rather than one row.
  try {
    const r = getResolution(cell);
    return Number.isInteger(r) && r >= 0 && r <= 15 ? r : null;
  } catch {
    return null;
  }
}

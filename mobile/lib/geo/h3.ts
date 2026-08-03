// H3 binding for the device.
//
// The server's geocontext/h3.ts loads h3-js from esm.sh, a URL specifier Metro
// cannot resolve. Rather than share the binding, both runtimes share the
// RESOLUTION — the parity-critical part — and each brings its own h3-js.
// Both are pinned to 4.1.0, so latLngToCell agrees on cell ids.
import { latLngToCell, gridDisk, cellToLatLng } from "h3-js";

export { H3_RESOLUTION } from "../../../shared/geo-core/geo/h3.ts";
import { H3_RESOLUTION } from "../../../shared/geo-core/geo/h3.ts";

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

// H3 cell key for GeoContext caching (computed app-side; the DB stores it as text —
// there is no h3-pg extension). Regional resolution ~7 (≈5 km hexagons) suits
// geological-context caching.
import { latLngToCell } from "https://esm.sh/h3-js@4.1.0";

export const H3_RESOLUTION = 7;

export function cellFor(lat: number, lng: number, res: number = H3_RESOLUTION): string {
  return latLngToCell(lat, lng, res);
}

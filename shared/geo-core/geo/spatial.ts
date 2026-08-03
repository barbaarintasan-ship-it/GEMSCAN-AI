// Spatial predicates — the whole PostGIS dependency, in TypeScript (§7.3).
//
// The server's 9 gateway methods reduce to exactly three predicates:
//   ST_Intersects(polygon, point)  → pointInRings
//   ST_Distance(geography, …)      → haversineM
//   ST_DWithin(…)                  → withinM (derived from haversineM)
// No topology, no buffers, no unions, no spatial joins.
//
// Shared, not device-local: the E3 differential suite compares these against
// PostGIS, so there must be exactly one implementation to compare.

/** IUGG mean Earth radius. */
const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (d: number) => (d * Math.PI) / 180;

export interface LatLng { lat: number; lng: number }

/**
 * Great-circle distance in metres.
 *
 * KNOWN DIVERGENCE (Architecture §7.4): PostGIS `ST_Distance` on `geography`
 * computes on the WGS84 ellipsoid; this computes on a sphere. Divergence is
 * ≤ ~0.5% (~50 m over a 10 km radius). It propagates into occurrence.ts's
 * linear `proximityWeight` and can flip `ST_DWithin` membership within ~50 m
 * of the radius edge. Accepted with a documented tolerance; exact ellipsoidal
 * parity (Vincenty/Karney) remains available if E3 shows it matters.
 */
export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** ST_DWithin. Inclusive at the boundary, matching PostGIS. */
export function withinM(a: LatLng, b: LatLng, radiusM: number): boolean {
  return haversineM(a, b) <= radiusM;
}

// ── Polygons ────────────────────────────────────────────────────────────────
export type Position = [number, number]; // [lng, lat]
export type Ring = Position[];
export type BBox = [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]

export function bboxContains(bbox: BBox, lng: number, lat: number): boolean {
  return lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

/**
 * Degrees of latitude/longitude covering `metres` at this latitude — used only
 * to widen a bbox before an exact distance test, never as a distance itself.
 * Near the poles cos(lat) collapses, so the longitude delta is clamped to a
 * full sweep rather than exploding to Infinity.
 */
export function bboxPadding(lat: number, metres: number): { dLat: number; dLng: number } {
  const dLat = (metres / EARTH_RADIUS_M) * (180 / Math.PI);
  const cos = Math.cos(toRad(lat));
  const dLng = Math.abs(cos) < 1e-9 ? 180 : dLat / cos;
  return { dLat, dLng: Math.min(180, dLng) };
}

/**
 * Ray-casting point-in-polygon over ALL rings at once (even-odd rule).
 *
 * The pack flattens a MultiPolygon's rings into one list, which is safe
 * precisely because this uses even-odd: a point inside an outer ring AND
 * inside one of its holes crosses twice — even — so it is correctly outside;
 * inside the outer ring only crosses once — odd — so it is inside. Separate
 * polygons of a MultiPolygon do not overlap, so their crossings never
 * interfere. A winding-number rule would need the outer/hole distinction the
 * flattening discards.
 */
export function pointInRings(rings: Ring[], lng: number, lat: number): boolean {
  let inside = false;
  for (const ring of rings) {
    const n = ring.length;
    if (n < 3) continue;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      // Does the horizontal ray at `lat` cross this edge, and if so is the
      // crossing to the right of the point?
      if ((yi > lat) !== (yj > lat)) {
        const x = xi + ((lat - yi) / (yj - yi)) * (xj - xi);
        if (x > lng) inside = !inside;
      }
    }
  }
  return inside;
}

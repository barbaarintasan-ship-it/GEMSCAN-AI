// Pure H3 polygon-fill logic — isolated from network/DB/auth so it is
// testable without a live Supabase project (see h3fill.test.ts).
//
// A PostGIS geography(MultiPolygon,4326) exported via ST_AsGeoJSON always
// yields coordinates shaped [ [ [ [lng,lat], ... ] , [hole ring], ... ], ... ]
// — an array of polygons, each polygon an array of rings (ring 0 = exterior,
// any further rings = holes). h3-js's polygonToCells fills exactly ONE
// polygon's ring-set per call (exterior minus holes) — it has no native
// MultiPolygon input — so every component is filled separately and the
// resulting cell sets are merged+deduped here. This is what "correctly
// handle all polygon components, correctly handle holes, do not fill holes,
// do not drop components" (Phase 2B, Step 1) means mechanically.
import { polygonToCells, isValidCell } from "https://esm.sh/h3-js@4.1.0";

export type GeoJsonMultiPolygon = {
  type: string;
  coordinates: number[][][][]; // [polygon][ring][position][lng,lat]
};

export class InvalidAreaGeometryError extends Error {}

/**
 * Enumerate the H3 cells covering a MultiPolygon at `resolution`.
 *
 * Deterministic and pure: the same geometry + resolution always yields the
 * same cell set (h3-js's polygonToCells has no randomness or floating
 * ordering dependency at the API surface we call — set-based dedup here
 * removes list ordering entirely, so callers get a stable sorted array).
 */
export function fillMultiPolygon(geojson: GeoJsonMultiPolygon, resolution: number): string[] {
  if (!geojson || geojson.type !== "MultiPolygon") {
    throw new InvalidAreaGeometryError("area boundary is not a MultiPolygon");
  }
  if (!Array.isArray(geojson.coordinates) || geojson.coordinates.length === 0) {
    throw new InvalidAreaGeometryError("area boundary has no polygon components");
  }

  const cells = new Set<string>();
  for (const polygonRings of geojson.coordinates) {
    if (!Array.isArray(polygonRings) || polygonRings.length === 0) {
      throw new InvalidAreaGeometryError("a polygon component has no rings");
    }
    // isGeoJson=true: rings are [lng,lat] (GeoJSON order); h3-js treats
    // ring 0 as the exterior boundary and every further ring as a hole to
    // SUBTRACT, never fill — this is the library doing exactly what Step 1
    // requires, not something this function has to implement itself.
    for (const cell of polygonToCells(polygonRings, resolution, true)) {
      cells.add(cell);
    }
  }

  if (cells.size === 0) {
    throw new InvalidAreaGeometryError(
      "area boundary produced zero H3 cells at this resolution (it may be smaller than one cell)",
    );
  }

  const result = Array.from(cells).sort();
  const invalid = result.filter((c) => !isValidCell(c));
  if (invalid.length > 0) {
    // Should never happen — h3-js only emits cells it considers valid — but
    // never hand ungenerated/attacker-shaped strings to a persistence RPC on
    // faith.
    throw new InvalidAreaGeometryError(`H3 enumeration produced invalid cell indexes: ${invalid.join(", ")}`);
  }

  return result;
}

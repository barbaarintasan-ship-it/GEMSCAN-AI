// A uniform-grid spatial index over map-feature bounding boxes.
//
// MOVED from mobile/lib/geo/featureIndex.ts (Solo→Team shared-targeting Phase 1).
// Zero mobile-only dependencies (no h3, no React Native) — pure index math over
// plain arrays, so the relocation changes nothing about its output. See
// mobile/lib/geo/featureIndex.ts for the re-export shim that keeps every
// existing Solo import unchanged.
//
// PURE PERFORMANCE. It changes nothing about WHAT featuresNear returns — same
// features, same distances, same order — only how fast the candidates are found.
//
// WHY THE OUTPUT IS IDENTICAL. featuresNear keeps a feature iff the query point is
// inside the feature's bbox padded by the radius — which is exactly "the feature's
// bbox overlaps the query rectangle [lng±dLng, lat±dLat]". The grid returns every
// feature whose bbox overlaps that rectangle (a SUPERSET of the matches), and the
// caller then applies the SAME padded-bbox test, the SAME polyline distance and the
// SAME radius filter to that superset. Candidates are handed back in ascending
// original-array order, so the caller pushes them in the same order the linear scan
// did and the stable distance sort breaks ties identically.
import type { PackMapFeature } from "../pack/types.ts";

/** Grid cell size in degrees. ~0.1° ≈ 11 km — a few cells cover a 10 km query. */
export const FEATURE_INDEX_CELL_DEG = 0.1;

export interface FeatureGridIndex {
  cell: number;
  /** "gx,gy" → indices into the original features array (ascending within a bucket). */
  buckets: Map<string, number[]>;
  /** The array this index was built for, so a stale index is never used. */
  count: number;
}

/** Build the grid once for a features array. O(features × cells-spanned). */
export function buildFeatureIndex(
  features: PackMapFeature[],
  cell = FEATURE_INDEX_CELL_DEG,
): FeatureGridIndex {
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < features.length; i++) {
    const b = features[i].bbox;
    const gx0 = Math.floor(b[0] / cell), gx1 = Math.floor(b[2] / cell);
    const gy0 = Math.floor(b[1] / cell), gy1 = Math.floor(b[3] / cell);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gy = gy0; gy <= gy1; gy++) {
        const k = gx + "," + gy;
        const arr = buckets.get(k);
        if (arr) arr.push(i);
        else buckets.set(k, [i]);
      }
    }
  }
  return { cell, buckets, count: features.length };
}

/**
 * Feature indices whose bbox may overlap the query rectangle, ascending and
 * de-duplicated. A SUPERSET of the true overlaps — the caller filters exactly.
 */
export function queryFeatureIndex(
  index: FeatureGridIndex,
  minLng: number, minLat: number, maxLng: number, maxLat: number,
): number[] {
  const { cell, buckets } = index;
  const gx0 = Math.floor(minLng / cell), gx1 = Math.floor(maxLng / cell);
  const gy0 = Math.floor(minLat / cell), gy1 = Math.floor(maxLat / cell);
  const seen = new Set<number>();
  for (let gx = gx0; gx <= gx1; gx++) {
    for (let gy = gy0; gy <= gy1; gy++) {
      const arr = buckets.get(gx + "," + gy);
      if (arr) for (let j = 0; j < arr.length; j++) seen.add(arr[j]);
    }
  }
  // Ascending original-array order → the caller iterates candidates exactly as the
  // linear scan iterated the whole array, so the stable distance sort ties match.
  return Array.from(seen).sort((a, b) => a - b);
}

/**
 * One index per features-array reference, built lazily.
 *
 * Keyed on the array itself (WeakMap), so a new pack builds a new index and an old
 * one is collected with it — no manual invalidation, no cross-pack bleed. `count`
 * guards the unlikely case of an array mutated in place.
 */
const CACHE = new WeakMap<PackMapFeature[], FeatureGridIndex>();

export function featureIndexFor(features: PackMapFeature[]): FeatureGridIndex {
  const cached = CACHE.get(features);
  if (cached && cached.count === features.length) return cached;
  const built = buildFeatureIndex(features);
  CACHE.set(features, built);
  return built;
}

// ── Generic bbox grid — for point-containment lookups like unitAt ─────────────
//
// Same grid, driven by a plain list of bounding boxes (a null entry is not
// indexed, e.g. a geology row that is not a polygon). The lookup is a SINGLE cell:
// any bbox that contains the query point necessarily spans the point's own cell,
// so that one bucket is the complete candidate set — a superset of the true
// containments, in ascending original-array order, which the caller filters
// exactly as the old linear scan did.
const EMPTY_CANDIDATES: number[] = [];

export function buildBboxIndex(
  bboxes: ReadonlyArray<readonly [number, number, number, number] | null | undefined>,
  cell = FEATURE_INDEX_CELL_DEG,
): FeatureGridIndex {
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < bboxes.length; i++) {
    const b = bboxes[i];
    if (!b) continue;
    const gx0 = Math.floor(b[0] / cell), gx1 = Math.floor(b[2] / cell);
    const gy0 = Math.floor(b[1] / cell), gy1 = Math.floor(b[3] / cell);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gy = gy0; gy <= gy1; gy++) {
        const k = gx + "," + gy;
        const arr = buckets.get(k);
        if (arr) arr.push(i);
        else buckets.set(k, [i]);
      }
    }
  }
  return { cell, buckets, count: bboxes.length };
}

/** Indices whose bbox may contain the point — the point's single cell, ascending. */
export function queryBboxIndexPoint(index: FeatureGridIndex, lng: number, lat: number): number[] {
  const arr = index.buckets.get(Math.floor(lng / index.cell) + "," + Math.floor(lat / index.cell));
  return arr ?? EMPTY_CANDIDATES;
}

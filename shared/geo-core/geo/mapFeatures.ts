// Structural map-feature proximity — faults, contacts, lineaments, drainage.
//
// EXTRACTED from mobile/lib/geo/terrainProviders.ts (Solo→Team shared-targeting
// Phase 1). Only the two PURE functions `prospectivityEvidence()` calls directly
// — `featuresNear` and `intersectionsOf` — move here; the GeoContextProvider
// wrappers (`makeMapLayerProvider`, terrain handling) stay in
// mobile/lib/geo/terrainProviders.ts, which now re-exports these two instead of
// declaring its own copy. Neither function touches h3 — they operate on plain
// `PackMapFeature[]` arrays and lat/lng numbers — so the relocation is a pure
// move with no behaviour change.
import {
  bboxContains, bboxPadding, pointToPolylineM, type Position,
} from "./spatial.ts";
import type { MapFeatureKind, PackMapFeature } from "../pack/types.ts";
import { featureIndexFor, queryFeatureIndex } from "./featureIndex.ts";

export interface NearbyFeature {
  id: string;
  kind: MapFeatureKind;
  name: string | null;
  distanceM: number;
  source: string | null;
}

/**
 * Distance from a position to every map feature within the radius, nearest first.
 *
 * Backed by a lazily-built spatial index (featureIndex.ts) so this is O(features
 * near the point) instead of O(all features).
 */
export function featuresNear(
  features: PackMapFeature[],
  lat: number,
  lng: number,
  radiusM: number,
): NearbyFeature[] {
  const { dLat, dLng } = bboxPadding(lat, radiusM);
  const index = featureIndexFor(features);
  const candidates = queryFeatureIndex(index, lng - dLng, lat - dLat, lng + dLng, lat + dLat);
  const out: NearbyFeature[] = [];
  for (let c = 0; c < candidates.length; c++) {
    const f = features[candidates[c]];
    const padded: [number, number, number, number] = [
      f.bbox[0] - dLng, f.bbox[1] - dLat, f.bbox[2] + dLng, f.bbox[3] + dLat,
    ];
    if (!bboxContains(padded, lng, lat)) continue;

    let best = Infinity;
    for (const line of f.lines) {
      const d = pointToPolylineM({ lat, lng }, line as Position[]);
      if (d < best) best = d;
    }
    if (best <= radiusM) {
      out.push({ id: f.id, kind: f.kind, name: f.name, distanceM: best, source: f.source });
    }
  }
  out.sort((a, b) => a.distanceM - b.distanceM);
  return out;
}

/**
 * Structural intersections are COMPUTED, not asserted.
 *
 * Where a fault and a contact both pass close to the same point, that
 * intersection is a stronger target than either alone — a classic structural
 * trap.
 */
const INTERSECTION_RADIUS_M = 500;

export function intersectionsOf(near: NearbyFeature[]): { kinds: MapFeatureKind[]; distanceM: number } | null {
  const close = near.filter((f) => f.distanceM <= INTERSECTION_RADIUS_M);
  const kinds = [...new Set(close.filter((f) => f.kind === "fault" || f.kind === "contact").map((f) => f.kind))];
  if (kinds.length < 2) return null;
  return { kinds, distanceM: Math.max(...close.filter((f) => kinds.includes(f.kind)).map((f) => f.distanceM)) };
}

// Server-side structural (fault/lineament) map-feature pack — closes part of
// the Team-scoring evidence gap documented in score-mission-cells's own
// EVIDENCE_CAVEAT.
//
// prospectivityEvidence()'s structural evidence block (shared/geo-core/gie/
// prospectivityEvidence.ts) only ever reads `pack.mapFeatures` — the exact
// shape Solo's own bundled offline pack produces (shared/geo-core/pack/
// types.ts). The server never built one, so Team missions scored with NO
// structural evidence at all — even though the underlying data
// (geo.structural_feature, 6,000 rows: 40 fault + 5,960 lineament, no
// contact yet) has been live in the database the whole time.
//
// This builds a MINIMAL PackData: every field empty except mapFeatures,
// fetched fresh per query point via geo.structural_features_geometry_near
// (0138). Passed as TargetingEngine's `pack` with NO `packOps` — so
// lithology/terrain priors (which need packOps) stay exactly as unavailable
// as they are today; only the structural block newly activates. Nothing in
// the validated baseline engine itself changes: this is the SAME code path
// Solo already exercises with its own bundled mapFeatures, now fed real
// server data instead of nothing.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import type { MapFeatureKind, PackData, PackMapFeature, Position } from "../../../../shared/geo-core/pack/types.ts";

export interface StructuralGeometryRow {
  id: string;
  feature_type: string;
  name: string | null;
  source_key: string | null;
  attributes: Record<string, unknown> | null;
  geojson: string;
}

// geo.structural_feature.feature_type is free text — today only 'fault' and
// 'lineament' exist (see migration 0138's own note). Anything unrecognised
// maps to 'other', which prospectivityEvidence()'s own filter
// (kind === "fault" || kind === "contact") already excludes from scoring —
// exactly how Solo's pipeline treats any mapFeature kind it doesn't score.
// 'lineament' is deliberately mapped THROUGH, not dropped here — the SAME
// exclusion-from-scoring already happens downstream, and this file is a
// geometry source, not a scoring decision.
const KIND_MAP: Record<string, MapFeatureKind> = {
  fault: "fault",
  contact: "contact",
  lineament: "lineament",
  drainage: "drainage",
};

function toKind(featureType: string): MapFeatureKind {
  return KIND_MAP[featureType] ?? "other";
}

export function bboxOf(lines: Position[][]): [number, number, number, number] {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const line of lines) {
    for (const [lng, lat] of line) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return [minLng, minLat, maxLng, maxLat];
}

/** GeoJSON LineString/MultiLineString → PackMapFeature.lines (Position[][]).
 *  Any other geometry type (or malformed JSON) returns null — the caller
 *  drops the row rather than guessing at a shape it wasn't given. */
export function linesFromGeoJson(geojson: string): Position[][] | null {
  let parsed: { type?: string; coordinates?: unknown };
  try {
    parsed = JSON.parse(geojson);
  } catch {
    return null;
  }
  if (parsed.type === "LineString" && Array.isArray(parsed.coordinates)) {
    return [parsed.coordinates as Position[]];
  }
  if (parsed.type === "MultiLineString" && Array.isArray(parsed.coordinates)) {
    return parsed.coordinates as Position[][];
  }
  return null;
}

export function structuralRowToMapFeature(row: StructuralGeometryRow): PackMapFeature | null {
  const lines = linesFromGeoJson(row.geojson);
  if (!lines || lines.length === 0) return null;
  return {
    id: row.id,
    kind: toKind(row.feature_type),
    name: row.name,
    source: row.source_key,
    attributes: row.attributes,
    lines,
    bbox: bboxOf(lines),
  };
}

export async function fetchStructuralMapFeatures(
  client: SupabaseClient<any, any>,
  lat: number,
  lng: number,
  radiusM: number,
): Promise<PackMapFeature[]> {
  const { data, error } = await client.schema("geo").rpc("structural_features_geometry_near", {
    p_lat: lat, p_lng: lng, p_radius_m: radiusM,
  });
  if (error) throw new Error(`structural_features_geometry_near: ${error.message}`);
  const rows = (data ?? []) as StructuralGeometryRow[];
  const features: PackMapFeature[] = [];
  for (const row of rows) {
    const f = structuralRowToMapFeature(row);
    if (f) features.push(f);
  }
  return features;
}

/** A minimal PackData carrying ONLY structural map features — every other
 *  field empty. Pass with no `packOps` (TargetingEngine's 5th constructor
 *  arg) so lithology/terrain stay exactly as unavailable as today; only
 *  prospectivityEvidence()'s structural block (pack.mapFeatures) newly
 *  activates. */
export function packWithMapFeatures(mapFeatures: PackMapFeature[]): PackData {
  return {
    geology: [], occurrences: [], knowledge: [], structures: [], community: [],
    mapFeatures, terrain: [], associations: [], rules: [], commodities: [],
    assemblages: [], land: [],
  };
}

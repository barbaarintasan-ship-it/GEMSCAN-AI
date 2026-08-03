// Offline knowledge pack — contracts (Architecture §7.2).
//
// A pack is a DERIVED artifact: immutable, versioned, read-only on the device,
// replaced wholesale rather than patched (Invariant 1). The server's geo.*
// tables remain the source of truth.
//
// These rows are SOURCE data, not query results. The server's gateway rows
// carry a `distance_m` the database computed; a pack stores the geometry and
// the device computes distance itself (Architecture §7.3), because the same
// rows must answer queries from positions nobody knew at build time.

/** Bumped only when the pack layout itself changes shape. */
export const PACK_FORMAT_VERSION = 1;

export interface PackDatasetRef {
  datasetId?: string;
  source: string;
  version?: string;
}

export interface PackManifest {
  packId: string;
  packVersion: string;
  formatVersion: number;
  /** Logic version this pack was built for; the app enforces a supported range. */
  engineVersion: string;
  region: string;
  builtAt: string;
  /** H3 resolution the cell indexes were computed at. */
  h3Resolution: number;
  /** [minLng, minLat, maxLng, maxLat] over everything in the pack; null when empty. */
  bbox: [number, number, number, number] | null;
  datasets: PackDatasetRef[];
  counts: Record<string, number>;
  /** filename → sha256 of that file's exact bytes. */
  files: Record<string, string>;
  /** sha256 over the canonical form of `files` — one value covering the whole pack. */
  sha256: string;
  /** Reserved for the update channel (E6); the bundled pack is trusted by APK provenance. */
  signature: string | null;
}

// ── Geometry ────────────────────────────────────────────────────────────────
/** [lng, lat] — GeoJSON axis order, so pack data can be exported without a flip. */
export type Position = [number, number];
/** Outer ring first, then holes. */
export type PolygonRings = Position[][];

export interface PackGeologyUnit {
  id: string;
  name: string;
  kind: string;
  source: string | null;
  attributes: Record<string, unknown> | null;
  rings: PolygonRings;
  /**
   * The index for polygons is the bbox, not an H3 cell list. A res-7 cell is
   * ~5.16 km² and a Macrostrat unit averages ~1850 km², so pre-computing cell
   * coverage would add ~124k entries across the set — larger than the rest of
   * the pack combined. Bbox rejection followed by exact point-in-polygon over
   * a few hundred units is both smaller and exact.
   */
  bbox: [number, number, number, number];
  /** Non-polygon geometry (mapped faults/lines) has no rings and never matches a point. */
  isPolygon: boolean;
}

export interface PackOccurrence {
  id: string;
  name: string | null;
  commodity_key: string | null;
  deposit_type: string | null;
  host_rocks: string[] | null;
  lat: number;
  lng: number;
  dataset_id: string;
  source: string;
  version: string | null;
  reference: string | null;
  cell: string;
}

export interface PackKnowledgeItem {
  id: string;
  kind: string;
  statement: string;
  commodity_key: string | null;
  host_rock_key: string | null;
  tier: string | null;
  page: number | null;
  lat: number;
  lng: number;
  source_title: string | null;
  dataset_id: string;
  dataset_source: string;
  dataset_version: string | null;
  cell: string;
}

export interface PackStructuralFeature {
  id: string;
  feature_type: string;
  name: string | null;
  lat: number;
  lng: number;
  attributes: Record<string, unknown> | null;
  cell: string;
}

/** Community aggregates are per-cell counts, not point data — no PII travels in a pack. */
export interface PackCommunityCell {
  cell: string;
  lat: number;
  lng: number;
  verified_scans: number;
  sample_count: number;
}

// ── Map layers (Architecture §7.7) ──────────────────────────────────────────
/** What a mapped line represents. Mirrors geo.geological_layer.kind. */
export type MapFeatureKind = "fault" | "contact" | "lineament" | "drainage" | "other";

export interface PackMapFeature {
  id: string;
  kind: MapFeatureKind;
  name: string | null;
  source: string | null;
  attributes: Record<string, unknown> | null;
  /** Polyline(s). A fault is a LINE, so proximity uses pointToPolylineM. */
  lines: Position[][];
  bbox: [number, number, number, number];
}

// ── Terrain (Architecture §7.7) ─────────────────────────────────────────────
/** Landform class at a cell. Derived from a DEM, never from imagery. */
export type TerrainMorphology = "ridge" | "slope" | "valley" | "flat";

/**
 * DEM derivatives per H3 cell rather than a raster: the engine asks "what is
 * the ground like HERE", not "render me a surface", which keeps the pack small
 * and the lookup O(1).
 */
export interface PackTerrainCell {
  cell: string;
  lat: number;
  lng: number;
  elevationM: number;
  slopeDeg: number;
  aspectDeg: number | null;
  /** Local relief — max minus min elevation in the neighbourhood. */
  reliefM: number;
  morphology: TerrainMorphology;
  /** Distance to the nearest mapped drainage, when drainage is in the pack. */
  drainageDistM: number | null;
}

export interface PackAssociation {
  commodity_code: string;
  host_rock_code: string;
  weight: number | null;
}

export interface PackKnowledgeRule {
  id: string;
  antecedent_type: string;
  antecedent_key: string;
  commodity_code: string | null;
  expected_minerals: string[] | null;
  relationship: string;
  likelihood: string;
  requires_setting: string[] | null;
  weight: number | null;
}

export interface PackCommodityProfile {
  code: string;
  name: string;
  category: string;
  typical_host_rocks: string[] | null;
  associated_minerals: string[] | null;
  alteration_styles: string[] | null;
  deposit_models: string[] | null;
  tectonic_settings: string[] | null;
  exploration_indicators: string[] | null;
  industrial_uses: string[] | null;
  is_critical_mineral: boolean | null;
  strategic_importance: string | null;
  confidence_limitations: string;
}

export interface PackAssemblageRule {
  id: string;
  minerals: string[];
  interpretation: string;
  commodity_code: string | null;
  likelihood: string;
  relationship: string;
  weight: number | null;
}

/** Everything a pack contains, before serialisation. */
export interface PackData {
  geology: PackGeologyUnit[];
  occurrences: PackOccurrence[];
  knowledge: PackKnowledgeItem[];
  structures: PackStructuralFeature[];
  community: PackCommunityCell[];
  mapFeatures: PackMapFeature[];
  terrain: PackTerrainCell[];
  associations: PackAssociation[];
  rules: PackKnowledgeRule[];
  commodities: PackCommodityProfile[];
  assemblages: PackAssemblageRule[];
}

/** A built pack: the exact file bytes plus the manifest describing them. */
export interface BuiltPack {
  manifest: PackManifest;
  /** filename → exact file content. What is written, hashed and verified. */
  files: Record<string, string>;
}

export const PACK_FILES = {
  geology: "geology.json",
  occurrences: "occurrences.json",
  knowledge: "knowledge.json",
  structures: "structures.json",
  community: "community.json",
  mapFeatures: "maplayers.json",
  terrain: "terrain.json",
  associations: "associations.json",
  rules: "rules.json",
  commodities: "commodities.json",
  assemblages: "assemblages.json",
} as const;

export const MANIFEST_FILE = "manifest.json";

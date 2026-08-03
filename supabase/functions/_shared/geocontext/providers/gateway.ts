// GeoContext providers — data gateway abstraction.
//
// Providers depend on this interface, NOT on a transport, so the same provider code
// runs against PostgREST (SupabaseGateway, deployed Edge Function) and against a
// direct Postgres connection (integration tests). Both hit the same 0058 RPCs + tables.

export interface GeologyRow {
  id: string;
  name: string;
  kind: string;
  source: string | null;
  attributes: Record<string, unknown> | null;
}

export interface OccurrenceRow {
  id: string;
  name: string | null;
  commodity_key: string | null;
  deposit_type: string | null;
  host_rocks: string[] | null;
  distance_m: number;
  dataset_id: string;
  source: string;
  version: string | null;
  reference: string | null;
}

export interface KnowledgeRow {
  id: string;
  kind: string;
  statement: string;
  commodity_key: string | null;
  host_rock_key: string | null;
  tier: string | null;
  page: number | null;
  distance_m: number;
  source_title: string | null;
  dataset_id: string;
  dataset_source: string;
  dataset_version: string | null;
}

export interface CommunityRow {
  verified_scans: number;
  sample_count: number;
  cell_count: number;
}

export interface AssociationRow {
  commodity_code: string;
  host_rock_code: string;
  weight: number | null;
}

// ── EMIE knowledge rows (0086–0090) ─────────────────────────────────────────
export interface KnowledgeRuleRow {
  id: string;
  antecedent_type: string;
  antecedent_key: string;
  commodity_code: string | null;
  expected_minerals: string[] | null;
  relationship: string;
  likelihood: string;        // diagnostic | common | possible | rare
  requires_setting: string[] | null;
  weight: number | null;
}
export interface CommodityProfileRow {
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
export interface AssemblageRuleRow {
  id: string;
  minerals: string[];
  interpretation: string;
  commodity_code: string | null;
  likelihood: string;        // diagnostic | common | possible | indicative
  relationship: string;
  weight: number | null;
}
export interface StructuralFeatureRow {
  id: string;
  feature_type: string;
  name: string | null;
  distance_m: number;
  attributes: Record<string, unknown> | null;
}

export interface GeoDataGateway {
  geologyAt(lat: number, lng: number): Promise<GeologyRow[]>;
  occurrencesNear(lat: number, lng: number, radiusM: number): Promise<OccurrenceRow[]>;
  knowledgeNear(lat: number, lng: number, radiusM: number): Promise<KnowledgeRow[]>;
  communityNear(lat: number, lng: number, radiusM: number): Promise<CommunityRow>;
  associationsForHostRocks(codes: string[]): Promise<AssociationRow[]>;
  // EMIE knowledge gateway
  knowledgeRulesFor(keys: { hostRocks: string[]; lithology: string[]; depositTypes: string[] }): Promise<KnowledgeRuleRow[]>;
  commodityProfiles(codes: string[]): Promise<CommodityProfileRow[]>;
  assemblageRulesFor(minerals: string[]): Promise<AssemblageRuleRow[]>;
  structuralFeaturesNear(lat: number, lng: number, radiusM: number): Promise<StructuralFeatureRow[]>;
}

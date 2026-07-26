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

export interface GeoDataGateway {
  geologyAt(lat: number, lng: number): Promise<GeologyRow[]>;
  occurrencesNear(lat: number, lng: number, radiusM: number): Promise<OccurrenceRow[]>;
  knowledgeNear(lat: number, lng: number, radiusM: number): Promise<KnowledgeRow[]>;
  communityNear(lat: number, lng: number, radiusM: number): Promise<CommunityRow>;
  associationsForHostRocks(codes: string[]): Promise<AssociationRow[]>;
}

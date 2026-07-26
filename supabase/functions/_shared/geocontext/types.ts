// GeoContext runtime — shared contracts (Architecture v1.1 §6/§7/§8).
//
// The engine never asserts presence and never calls an LLM; it fuses provider
// contributions into one structured GeoContext object with evidence + confidence.

export type ProviderCategory = "spatial" | "knowledge";

export interface GeoQuery {
  lat: number;
  lng: number;
  radiusM: number;
  h3?: string; // precomputed cell (cache key); computed app-side, not in the DB
  mineralHint?: string; // from AI identification, optional
}

export interface Provenance {
  source: string;
  datasetVersion?: string;
  reference?: string;
  page?: number;
  quote?: string;
  extractionVersion?: string;
  parser?: string;
  ingestedAt?: string;
}

export interface Temporal {
  observationDate?: string;
  publicationYear?: number;
  explorationPeriod?: string;
}

export interface EvidenceItem {
  statement: string; // human-readable, e.g. "Quartz vein within 400 m"
  weight: number; // 0..1
  tier?: string; // evidence tier code (drives weighting)
  provenance?: Provenance;
  temporal?: Temporal;
}

// A dataset/version the caller can trace a conclusion back to.
export interface DatasetRef {
  datasetId?: string; // geo.dataset_registry.id
  source: string; // e.g. 'USGS MRDS'
  version?: string; // dataset version
}

// A provider's partial view of the world at the query location.
export interface ProviderContribution {
  provider: string;
  category: ProviderCategory;
  priority: number; // conflict-resolution rank (lower = higher priority)
  data: Partial<GeoContextData>; // provider-shaped partial context
  evidence: EvidenceItem[];
  confidence: number; // 0..1 provider-local confidence
  datasets?: DatasetRef[]; // dataset/version IDs this contribution drew from
}

export interface GeoContextProvider {
  readonly name: string;
  readonly category: ProviderCategory;
  readonly priority: number;
  // Must be side-effect free and cacheable.
  fetch(q: GeoQuery): Promise<ProviderContribution>;
}

// ── Output JSON (Architecture §8) ──────────────────────────────────────────
export interface ScalarWithAlternatives<T> {
  value: T;
  source?: string;
  alternatives?: Array<{ value: T; source?: string }>;
}

export interface GeoContextData {
  geology: Partial<{
    unit: string;
    tectonicProvince: string;
    structuralSetting: string;
  }>;
  formations: Array<Record<string, unknown>>;
  lithology: Array<Record<string, unknown>>;
  hostRocks: string[];
  faults: Array<Record<string, unknown>>;
  intrusions: Array<Record<string, unknown>>;
  metamorphism: Partial<{ belt: string; grade: string }>;
  knownOccurrences: Array<Record<string, unknown>>;
  commodityAssociations: Array<Record<string, unknown>>;
  geochemistry: { anomalies: Array<Record<string, unknown>> };
  geophysics: { anomalies: Array<Record<string, unknown>> };
  remoteSensing: { alteration: Array<Record<string, unknown>> };
  historicalReports: Array<Record<string, unknown>>;
  communityEvidence: Partial<{
    verifiedScans: number;
    expertConfirmations: number;
    labConfirmations: number;
    clusterDensity: number;
  }>;
}

export type ConfidenceBand = "Low" | "Moderate" | "High";

export interface ConfidenceBlock {
  overall: ConfidenceBand;
  score: number; // 0..1
  byProvider: Record<string, number>;
  factors: string[];
}

// Explainability: exactly which providers contributed, their confidence, and the
// datasets/versions behind the conclusion — so the UI can show WHY.
export interface ProviderEvidence {
  provider: string;
  category: ProviderCategory;
  contributed: boolean; // ran successfully AND produced data/evidence
  confidence: number;
  evidenceCount: number;
  datasets: DatasetRef[];
  error?: string; // set when the provider failed
}

export interface EvidenceReport {
  providers: ProviderEvidence[];
  datasets: DatasetRef[]; // union across contributing providers
}

export interface GeoContext extends GeoContextData {
  location: { lat: number; lng: number; h3?: string };
  reasoningFactors: string[];
  evidence: EvidenceReport;
  confidence: ConfidenceBlock;
  meta: {
    engineVersion: string;
    generatedAt: string;
    providersRun: string[];
    providersFailed: string[];
    cache: "hit" | "miss";
  };
}

// Cache abstraction — the DB-backed geo.geocontext_cache is injected later; tests
// use an in-memory implementation.
export interface CacheStore {
  get(h3: string, engineVersion: string): Promise<GeoContext | null>;
  set(h3: string, engineVersion: string, ctx: GeoContext, ttlSeconds?: number): Promise<void>;
}

// Geological Intelligence Engine (Sprint 4.3) — shared contracts.
//
// The Evidence Set is the single input to reasoning (S4): every gathered item,
// each traceable to a source, ready to become a node in the persisted evidence
// graph. Confidence is computed from these later — never invented (Principle #4).

export type EvidenceType =
  | "field"        // recorded by the collector in the field (an observation/fact)
  | "visual"       // derived by AI vision from the photos (S3)
  | "spatial"      // geological map / lithology / structure at the location
  | "occurrence"   // mineral occurrences / MRDS / historical mining nearby
  | "knowledge"    // GeoContext knowledge base / regional history
  | "association"  // mineral associations for the host rocks
  | "prior_sample"; // previous verified / community samples nearby

// One evidence item. `id` is a short, stable handle (e1, e2, …) that the reasoning
// stage references so every conclusion links back to concrete evidence.
// Bilingual text — the app runs in English or Somali, so AI-facing content
// carries both; the UI picks by language and falls back to English.
export interface Bilingual { en: string; so: string }

export interface EvidenceNode {
  id: string;
  source: string;          // provider / table the item came from
  evType: EvidenceType;
  statement: string;       // human-readable (English)
  statementSo?: string;    // Somali translation when available (else fall back to en)
  isObservation: boolean;  // true ⇒ fact, false ⇒ derived/inferred
  // Epistemic status (EMIE): how strongly the statement is grounded. Field/visual
  // facts are "observed"; spatial/occurrence inferences "inferred"; knowledge-base
  // expectations "possible"; a knowledge relationship whose required setting is
  // contradicted "unsupported". Drives the reasoning layer's language, not confidence.
  epistemic?: "observed" | "inferred" | "possible" | "unsupported";
  tier?: string;           // evidence_tier code (drives confidence weighting, S4)
  quality: number;         // 0..1 item strength/quality
  datasetId?: string;      // geo.dataset_registry.id when known
  provenance?: Record<string, unknown>;
}

// The sample fields analyze-sample reads from the DB and turns into field evidence.
export interface SampleInput {
  id: string;
  name: string | null;
  lat: number;
  lng: number;
  altitudeM?: number | null;
  gpsAccuracyM?: number | null;
  collectedAt?: string | null;
  terrainType?: string | null;
  geologicalEnvironment?: string | null;
  fieldObservations?: string | null;
  hostRock?: { rockClass?: string | null; texture?: string | null; weathering?: string | null; notes?: string | null } | null;
  minerals: Array<{ mineral: string; confidence?: number | null }>;
  alteration?: { alterationType?: string | null; intensity?: string | null; notes?: string | null } | null;
  structural: Array<{ structureType?: string | null; strikeDeg?: number | null; dipDeg?: number | null; dipDirection?: number | null }>;
}

// An evidence item before it gets its stable id (produced by each gatherer stage).
export type EvidenceInput = Omit<EvidenceNode, "id">;

export interface EvidenceSet {
  nodes: EvidenceNode[];
  providersRun: string[];
  providersFailed: string[];
  countsByType: Record<EvidenceType, number>;
}

// GIE reasoning contracts — the shape the AI must produce, with no AI in it.
//
// These types lived in gie/reasoning.ts, which also holds the Gemini call
// (`Deno.env`, `fetch`). scoring.ts and assemble.ts need only the SHAPES, so
// keeping them next to the transport forced every consumer — including the
// mobile app, which will never call Gemini — to pull a server-only module into
// its type graph. They are pure declarations and belong in the shared core.
//
// reasoning.ts re-exports everything here, so no existing import changed.
import type { Bilingual } from "./types.ts";

export type ConclusionKind =
  | "rock_type" | "mineralization" | "ore_mineral" | "gangue_mineral"
  | "environment" | "deposit_model" | "exploration_significance";

export interface EvidenceLink { evidenceId: string; contribution: number }

export interface RawConclusion {
  kind: ConclusionKind;
  statement: string;   // English
  statementSo: string; // Somali
  isInterpretation: boolean;
  supporting: EvidenceLink[];
  contradicting: EvidenceLink[];
}

export interface RawRecommendation { action: string; actionSo: string; scaleM?: number; evidenceIds: string[] }

// Geological Interpretation Layer — turns technical evidence into clear, educational
// exploration knowledge (NOT audio/voice; it is the teaching narrative a field
// geologist would give). Bilingual; sourced from the evidence, never invented.
export interface InterpretationLayer {
  whatItIs: Bilingual;       // what this is + how it formed (process)
  commonlyHosts: Bilingual;  // associated minerals / commodities commonly found here
  lookForNext: Bilingual;    // indicator minerals + practical field steps
  whyItMatters: Bilingual;   // industrial / strategic importance (NO prices)
  environment: Bilingual;    // geological/tectonic setting + why explorers care
}

export interface ReasoningOutput {
  // Plain-language, non-expert facing (Simple mode).
  headline: Bilingual;        // one clear sentence: what it likely is + the opportunity
  simpleSummary: Bilingual;   // 3–5 everyday-language sentences
  opportunity: "high" | "moderate" | "low" | "none"; // honest exploration-potential signal
  interpretation: InterpretationLayer; // the Geological Interpretation Layer
  conclusions: RawConclusion[];
  uncertainties: Bilingual[];
  missingInformation: Bilingual[];
  recommendations: RawRecommendation[];
}

// GIE stage 3 — REASON (Sprint 4.3 S4).
//
// One structured Gemini call that reasons like an exploration geologist over the
// full Evidence Set. It proposes conclusions and links each to concrete evidence
// ids (supporting / contradicting); it is FORBIDDEN from emitting confidence
// numbers — the engine computes those from the evidence (scoring.ts). The AI
// proposes; the engine adjudicates. The call is injected so parsing stays pure.
import type { Bilingual, EvidenceNode } from "./types.ts";

const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest";

export type ConclusionKind =
  | "rock_type" | "mineralization" | "ore_mineral" | "gangue_mineral"
  | "environment" | "deposit_model" | "exploration_significance";
const KINDS: ConclusionKind[] = [
  "rock_type", "mineralization", "ore_mineral", "gangue_mineral",
  "environment", "deposit_model", "exploration_significance",
];

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
export interface ReasoningOutput {
  conclusions: RawConclusion[];
  uncertainties: Bilingual[];
  missingInformation: Bilingual[];
  recommendations: RawRecommendation[];
}

export interface ReasoningDeps { generate: (prompt: string) => Promise<string> }

// ── Pure: prompt ────────────────────────────────────────────────────────────
export function buildReasoningPrompt(nodes: EvidenceNode[], sampleSummary: string): string {
  const evidenceList = nodes
    .map((n) => `[${n.id}] (${n.evType}${n.tier ? `, tier ${n.tier}` : ""}): ${n.statement}`)
    .join("\n");
  return [
    "You are an experienced exploration geologist. Evaluate ALL the evidence below and",
    "reach conclusions the way a professional would for a preliminary field assessment.",
    "",
    `SAMPLE: ${sampleSummary}`,
    "",
    "EVIDENCE (reference items by their id, e.g. e3):",
    evidenceList || "(no evidence available)",
    "",
    "Rules:",
    "- Combine evidence; never rely on a single indicator or the photos alone.",
    "- Every conclusion MUST cite the evidence ids that support it. Cite contradicting ids too.",
    "- Distinguish observations from interpretations (is_interpretation).",
    "- DO NOT output any confidence or probability numbers — the engine computes confidence.",
    "- Recommendations must be conservative and practical: default to 1–10 m follow-up",
    "  (document outcrop, collect nearby, expose fresh surface, measure vein orientation,",
    "  record structure, inspect alteration, photograph angles). Only propose larger",
    "  distances when multiple independent datasets justify it; put the distance in scale_m.",
    "- Write ALL human text in BOTH English and Somali: every statement/action/uncertainty/",
    "  missing item needs an English field and a Somali field (…_so). Keep mineral, rock and",
    "  place names as given.",
    "",
    "Conclusion kinds: rock_type, mineralization, ore_mineral, gangue_mineral, environment,",
    "deposit_model, exploration_significance.",
    "",
    "Output STRICT JSON only:",
    '{"conclusions":[{"kind":"rock_type","statement":"...","statement_so":"...","is_interpretation":true,',
    '  "supporting":[{"evidence_id":"e1","contribution":0.7}],',
    '  "contradicting":[{"evidence_id":"e9","contribution":0.3}]}],',
    '"uncertainties":[{"en":"...","so":"..."}],"missing_information":[{"en":"...","so":"..."}],',
    '"recommendations":[{"action":"...","action_so":"...","scale_m":2,"evidence_ids":["e1"]}]}',
  ].join("\n");
}

// ── Pure: parse + validate ──────────────────────────────────────────────────
export function parseReasoningResponse(text: string): ReasoningOutput {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(cleaned) as Record<string, unknown>; } catch { return empty(); }

  const conclusions: RawConclusion[] = [];
  for (const raw of asArray(obj.conclusions)) {
    const r = raw as Record<string, unknown>;
    const statement = str(r.statement);
    const kind = KINDS.includes(r.kind as ConclusionKind) ? (r.kind as ConclusionKind) : null;
    if (!statement || !kind) continue;
    conclusions.push({
      kind,
      statement,
      statementSo: str(r.statement_so) || statement,
      isInterpretation: r.is_interpretation !== false,
      supporting: links(r.supporting),
      contradicting: links(r.contradicting),
    });
  }
  const recommendations: RawRecommendation[] = asArray(obj.recommendations).map((raw) => {
    const r = raw as Record<string, unknown>;
    const action = str(r.action);
    return {
      action,
      actionSo: str(r.action_so) || action,
      scaleM: Number.isFinite(Number(r.scale_m)) ? Number(r.scale_m) : undefined,
      evidenceIds: asArray(r.evidence_ids).map(str).filter(Boolean),
    };
  }).filter((r) => r.action);

  return {
    conclusions,
    uncertainties: bilinguals(obj.uncertainties),
    missingInformation: bilinguals(obj.missing_information),
    recommendations,
  };
}

// Accept either ["text"] (mirror to both) or [{en,so}] and normalise to Bilingual[].
function bilinguals(v: unknown): Bilingual[] {
  return asArray(v).map((raw) => {
    if (typeof raw === "string") { const t = raw.trim(); return { en: t, so: t }; }
    const r = raw as Record<string, unknown>;
    const en = str(r.en); const so = str(r.so) || en;
    return { en, so };
  }).filter((b) => b.en);
}

export async function runReasoning(nodes: EvidenceNode[], sampleSummary: string, deps: ReasoningDeps): Promise<ReasoningOutput> {
  const text = await deps.generate(buildReasoningPrompt(nodes, sampleSummary));
  return parseReasoningResponse(text);
}

// ── Default deps: the real Gemini call ──────────────────────────────────────
export const defaultReasoningDeps: ReasoningDeps = {
  generate: async (prompt) => {
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("GEMINI_API_KEY not configured");
    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, responseMimeType: "application/json" },
    };
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    );
    const raw = await res.json();
    if (!res.ok) throw new Error(raw?.error?.message ?? `Gemini API error (status ${res.status})`);
    return raw?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  },
};

function empty(): ReasoningOutput {
  return { conclusions: [], uncertainties: [], missingInformation: [], recommendations: [] };
}
function asArray(v: unknown): unknown[] { return Array.isArray(v) ? v : []; }
function str(v: unknown): string { return typeof v === "string" ? v.trim() : ""; }
function links(v: unknown): EvidenceLink[] {
  return asArray(v).map((raw) => {
    const r = raw as Record<string, unknown>;
    const evidenceId = str(r.evidence_id);
    const contribution = Math.max(0, Math.min(1, Number(r.contribution)));
    return { evidenceId, contribution: Number.isFinite(contribution) ? contribution : 0 };
  }).filter((l) => l.evidenceId);
}

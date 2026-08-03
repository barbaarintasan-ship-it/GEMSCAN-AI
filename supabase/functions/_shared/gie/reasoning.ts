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

export interface ReasoningDeps { generate: (prompt: string) => Promise<string> }

// ── Pure: prompt ────────────────────────────────────────────────────────────
export function buildReasoningPrompt(nodes: EvidenceNode[], sampleSummary: string): string {
  // Each evidence line carries its epistemic status so the model can honour it:
  // observed = a fact we can see; inferred = mapped/derived; possible = knowledge-base
  // expectation; unsupported = a relationship whose setting is contradicted.
  const evidenceList = nodes
    .map((n) => `[${n.id}] (${n.evType}${n.tier ? `, tier ${n.tier}` : ""}, ${n.epistemic ?? "inferred"}): ${n.statement}`)
    .join("\n");
  return [
    "You are a SENIOR FIELD EXPLORATION GEOLOGIST who loves teaching. You are speaking",
    "directly to an enthusiastic prospector who wants to understand their sample and its",
    "surroundings. Be warm, confident, engaging and EDUCATIONAL. Never stop at naming a",
    "rock or mineral — always explain what it MEANS for exploration.",
    "",
    `SAMPLE: ${sampleSummary}`,
    "",
    "EVIDENCE (reference items by id, e.g. e3; each line ends with its epistemic status):",
    evidenceList || "(no evidence available)",
    "",
    "How to reason:",
    "- Combine evidence; never rely on a single indicator or the photos alone.",
    "- Every conclusion MUST cite the evidence ids that support it. Cite contradicting ids too.",
    "- Honour each item's epistemic status. An 'observed' item is something we can see; a",
    "  'possible' knowledge item is what this rock/environment COMMONLY hosts — not a claim it",
    "  is here. Do NOT upgrade a 'possible' into 'likely/confirmed' unless at least one",
    "  'observed' item corroborates it. Knowledge deepens understanding; it must not inflate certainty.",
    "- DO NOT output any confidence or probability numbers — the engine computes confidence.",
    "- Evidence ids (e.g. e3, [e5]) belong ONLY inside each conclusion's supporting/contradicting",
    "  arrays. NEVER write an evidence id in the headline, simple_summary, interpretation, uncertainties,",
    "  recommendations or any human-facing sentence — those must read as clean prose.",
    "",
    "TONE — write like a senior field geologist, NOT a lawyer:",
    "- Positive, engaging, confident, educational. Teach exploration geology.",
    "- Proactively answer what the user hasn't asked: what valuable minerals commonly occur",
    "  here, what an explorer would look for next, how this formed, why it matters industrially",
    "  or strategically, what geological setting this belongs to.",
    "- When something is uncertain, frame it as the NEXT thing to check in the field — NOT as a",
    "  warning or disclaimer. Do NOT use corporate/legal disclaimer language.",
    "- NEVER discuss prices or monetary value. Explain industrial and strategic importance instead",
    "  (e.g. batteries, magnets, electronics, aerospace, steel, critical-mineral status).",
    "",
    "CALIBRATION — keep IDENTIFICATION and OPPORTUNITY separate and independent:",
    "- Two different things: (1) IDENTIFICATION confidence — how sure we are WHAT the sample is; and",
    "  (2) EXPLORATION POTENTIAL — how valuable the geological setting could be. They are independent:",
    "  a sample can have only moderate identification confidence yet sit in a high-potential setting.",
    "  Communicate BOTH; never let one masquerade as the other.",
    "- NEVER present an uncertain interpretation as an established fact. Do NOT write 'You have located",
    "  X' or 'This is X'. Use observational, evidence-led wording instead: 'Your sample shows…',",
    "  'This sample displays…', 'This location exhibits…', 'The available evidence suggests…',",
    "  'This is an encouraging exploration target for…'.",
    "- Let the enthusiasm come from the geological OPPORTUNITY, not from overstating certainty. When",
    "  the identification rests mainly on 'possible'/knowledge items or a single observation, keep the",
    "  identification wording tentative even while the opportunity is genuinely exciting.",
    "",
    "Recommendations: conservative and practical — default to 1–10 m follow-up (document outcrop,",
    "collect nearby, expose fresh surface, measure vein orientation, record structure, inspect",
    "alteration, pan for indicator minerals). Larger distances only when multiple independent",
    "datasets justify it; put the distance in scale_m.",
    "",
    "Write ALL human text in BOTH English and Somali (…_so). The SOMALI must be simple, clear,",
    "natural everyday Somali that ANY person — even a young student — can understand: short sentences,",
    "common words, warm and fluent (not stiff, not heavily technical, not a word-for-word translation).",
    "Explain the meaning rather than translating literally. Keep mineral, rock and place names as given,",
    "and when a technical term has no everyday Somali word, keep the term and add a short plain gloss in",
    "parentheses, e.g. 'kimberlite (dhagax foolkano ah oo qoto dheer)'.",
    "",
    "Conclusion kinds: rock_type, mineralization, ore_mineral, gangue_mineral, environment,",
    "deposit_model, exploration_significance.",
    "",
    "PLAIN-LANGUAGE layer (for non-geologists):",
    "- headline: ONE short everyday sentence. State the identification with CALIBRATED, observational",
    "  wording (never as established fact) AND convey the exploration opportunity with optimism —",
    "  e.g. 'Your sample shows features consistent with kimberlite — an encouraging target for diamond",
    "  exploration.' Name the valuable mineral, but tie the certainty to the evidence, not to hope.",
    "- simple_summary: 3–5 short beginner sentences, no jargon.",
    "- opportunity: exactly one of high | moderate | low | none — this is the EXPLORATION POTENTIAL of",
    "  the setting (independent of how confident the identification is).",
    "",
    "GEOLOGICAL INTERPRETATION layer — the teaching narrative (BOTH languages), grounded in the",
    "evidence and knowledge items above. Fill each field with 1–3 engaging sentences:",
    "- what_it_is: what this rock/environment is and how it formed.",
    "- commonly_hosts: the minerals/commodities commonly associated with it (from the knowledge items).",
    "- look_for_next: indicator minerals and practical field steps an explorer would take next.",
    "- why_it_matters: the industrial/strategic importance of the relevant commodities (NO prices).",
    "- environment: the geological/tectonic setting and why exploration companies are interested.",
    "",
    "Output STRICT JSON only:",
    '{"headline":{"en":"...","so":"..."},"simple_summary":{"en":"...","so":"..."},"opportunity":"moderate",',
    '"interpretation":{"what_it_is":{"en":"...","so":"..."},"commonly_hosts":{"en":"...","so":"..."},',
    '  "look_for_next":{"en":"...","so":"..."},"why_it_matters":{"en":"...","so":"..."},"environment":{"en":"...","so":"..."}},',
    '"conclusions":[{"kind":"rock_type","statement":"...","statement_so":"...","is_interpretation":true,',
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
    const statement = stripIds(str(r.statement));
    const kind = KINDS.includes(r.kind as ConclusionKind) ? (r.kind as ConclusionKind) : null;
    if (!statement || !kind) continue;
    conclusions.push({
      kind,
      statement,
      statementSo: stripIds(str(r.statement_so)) || statement,
      isInterpretation: r.is_interpretation !== false,
      supporting: links(r.supporting),
      contradicting: links(r.contradicting),
    });
  }
  const recommendations: RawRecommendation[] = asArray(obj.recommendations).map((raw) => {
    const r = raw as Record<string, unknown>;
    const action = stripIds(str(r.action));
    return {
      action,
      actionSo: stripIds(str(r.action_so)) || action,
      scaleM: Number.isFinite(Number(r.scale_m)) ? Number(r.scale_m) : undefined,
      evidenceIds: asArray(r.evidence_ids).map(str).filter(Boolean),
    };
  }).filter((r) => r.action);

  const opp = str((obj as { opportunity?: unknown }).opportunity).toLowerCase();
  return {
    headline: oneBilingual(obj.headline),
    simpleSummary: oneBilingual(obj.simple_summary),
    opportunity: (["high", "moderate", "low", "none"].includes(opp) ? opp : "none") as ReasoningOutput["opportunity"],
    interpretation: parseInterpretation(obj.interpretation),
    conclusions,
    uncertainties: bilinguals(obj.uncertainties),
    missingInformation: bilinguals(obj.missing_information),
    recommendations,
  };
}

// Parse a single {en,so} object (or a bare string) into one Bilingual.
function oneBilingual(v: unknown): Bilingual {
  if (typeof v === "string") { const t = stripIds(v); return { en: t, so: t }; }
  const r = (v ?? {}) as Record<string, unknown>;
  const en = stripIds(str(r.en)); const so = stripIds(str(r.so)) || en;
  return { en, so };
}

function parseInterpretation(v: unknown): InterpretationLayer {
  const o = (v ?? {}) as Record<string, unknown>;
  return {
    whatItIs: oneBilingual(o.what_it_is),
    commonlyHosts: oneBilingual(o.commonly_hosts),
    lookForNext: oneBilingual(o.look_for_next),
    whyItMatters: oneBilingual(o.why_it_matters),
    environment: oneBilingual(o.environment),
  };
}
const EMPTY_BI: Bilingual = { en: "", so: "" };
const EMPTY_INTERPRETATION: InterpretationLayer = {
  whatItIs: EMPTY_BI, commonlyHosts: EMPTY_BI, lookForNext: EMPTY_BI, whyItMatters: EMPTY_BI, environment: EMPTY_BI,
};

// Accept either ["text"] (mirror to both) or [{en,so}] and normalise to Bilingual[].
function bilinguals(v: unknown): Bilingual[] {
  return asArray(v).map((raw) => {
    if (typeof raw === "string") { const t = stripIds(raw); return { en: t, so: t }; }
    const r = raw as Record<string, unknown>;
    const en = stripIds(str(r.en)); const so = stripIds(str(r.so)) || en;
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
  return {
    headline: { en: "", so: "" }, simpleSummary: { en: "", so: "" }, opportunity: "none",
    interpretation: EMPTY_INTERPRETATION,
    conclusions: [], uncertainties: [], missingInformation: [], recommendations: [],
  };
}
function asArray(v: unknown): unknown[] { return Array.isArray(v) ? v : []; }
function str(v: unknown): string { return typeof v === "string" ? v.trim() : ""; }
// Defensive: strip any evidence-id references (e.g. "[e5]", "(e3, e8)") that leak into
// human-facing prose, and tidy the leftover spacing/punctuation. Evidence ids belong
// only in the conclusion edges — never in the report text.
function stripIds(s: string): string {
  return s
    .replace(/\s*[[(]\s*e\d+(?:\s*,\s*e\d+)*\s*[\])]/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}
function links(v: unknown): EvidenceLink[] {
  return asArray(v).map((raw) => {
    const r = raw as Record<string, unknown>;
    const evidenceId = str(r.evidence_id);
    const contribution = Math.max(0, Math.min(1, Number(r.contribution)));
    return { evidenceId, contribution: Number.isFinite(contribution) ? contribution : 0 };
  }).filter((l) => l.evidenceId);
}

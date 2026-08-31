// Asking a model to read a field mission, and reading its answer back.
//
// Prompt and parser only. No network, no model, no keys — so both halves are
// testable, and the rules below are enforced in code rather than hoped for in
// English.
//
// THE BOUNDARY THAT MATTERS MOST
//
// The prospectivity engine's output goes IN as evidence. It never comes back out.
// The engine is validated — LOO AUC 0.900, BLIND 0.843, measured on the real pack —
// and an interpretation layer that could adjust its score would silently replace a
// measured model with an unmeasured opinion. So:
//
//   · the score, the coverage states and the layer readings are given as FACTS
//   · `MissionFindings` has no score field, so a model cannot return one
//   · `parseMissionFindings` DISCARDS any score-like key it is sent
//   · the report renders the score from the PACKAGE, never from the analysis
//
// The AI is the interpretation layer above the engine, not a second engine.
//
// THE OTHER RULE
//
// A geologist reading this must never be told odds. Absence of evidence is stated
// out loud, because in greenfield exploration almost everything is absent and a
// report listing only what was found reads as a complete picture.
import {
  MISSION_FINDINGS_VERSION,
  type ConfidenceLevel, type EvidenceOrigin, type EvidenceStatus,
  type EvidenceStrength, type FindingEvidence, type FindingRecommendation,
  type GeologicalInterest, type MissionFindings,
} from "../../../../shared/geo-core/gie/missionFindings.ts";

/** Exactly what the model is allowed to say. Anything else is discarded. */
const INTERESTS: GeologicalInterest[] = ["notable", "moderate", "limited", "none"];
const CONFIDENCES: ConfidenceLevel[] = ["high", "medium", "low"];
const STRENGTHS: EvidenceStrength[] = ["strong", "moderate", "weak", "absent"];
const ORIGINS: EvidenceOrigin[] = [
  "field_observation", "photograph", "engine_layer", "commodity_profile",
];
const STATUSES: EvidenceStatus[] = [
  "present", "not_scored", "none_here", "empty_layer", "no_source",
];

/**
 * Keys that would mean the model had recomputed the geology.
 *
 * Stripped on the way in. A model asked for a qualitative assessment will
 * sometimes helpfully add `prospectivity_score: 0.62`, and once such a number
 * exists something downstream will eventually display it — at which point the
 * validated engine has been quietly replaced by a guess.
 */
const REJECTED_KEYS = [
  "score", "prospectivity", "prospectivity_score", "probability", "percent",
  "percentage", "chance", "odds", "likelihood", "grade", "tonnage",
];

/** What the engine already knows, handed to the model as given facts. */
export interface EnginePackageSummary {
  missionId: string;
  commodity: string | null;
  /** The engine's own score. Passed through untouched, never recomputed. */
  prospectivityScore: number;
  targetCell: string;
  lat: number;
  lng: number;
  gpsAccuracyM: number | null;
  lithology: string | null;
  terrainMorphology: string | null;
  elevationM: number | null;
  /** Metres to the nearest mapped fault, or null when none is in range. */
  faultDistanceM: number | null;
  contactDistanceM: number | null;
  drainageDistanceM: number | null;
  /** Every evidence role and the state the engine reported for it. */
  coverage: Array<{ role: string; status: EvidenceStatus }>;
  /** Structured reasons the engine offered for this target. */
  engineReasons: string[];
  observations: Array<{
    type: string;
    notes: string;
    positionQuality: string;
    photoCount: number;
    /** The device's photo ids, so a visual reading can cite the image it came from. */
    photoIds?: string[];
  }>;
  photoCount: number;
  trackPoints: number;
}

export function buildMissionPrompt(p: EnginePackageSummary): string {
  const layer = (name: string, value: string | number | null, unit = "") =>
    `  ${name}: ${value == null ? "NOT AVAILABLE" : `${value}${unit}`}`;

  return [
    "You are a senior exploration geologist writing an assessment of one field",
    "mission in Somalia. You are the INTERPRETATION layer above a validated",
    "offline prospectivity engine.",
    "",
    "ABSOLUTE RULES",
    "1. NEVER state a probability, percentage, chance or odds of finding anything.",
    "   Not in English, not in Somali. No '70% chance', no 'boqolkiiba 70'.",
    "2. NEVER say a deposit is confirmed, guaranteed, certain or definite.",
    "3. NEVER recompute or contradict the prospectivity score below. It is a given",
    "   fact from a measured model. Do not output a score of your own.",
    "4. NEVER invent evidence. If a layer says NOT AVAILABLE, it was not measured —",
    "   that is different from being measured and found absent, and you must say so.",
    "5. State what is MISSING explicitly. In greenfield exploration most evidence is",
    "   absent, and a report listing only what was found reads as a complete picture.",
    "",
    "WHAT THE ENGINE MEASURED (facts — use as evidence, do not alter)",
    layer("prospectivity score (0..1, a RANKING not a probability)", p.prospectivityScore),
    layer("commodity assessed", p.commodity ?? "none — universal assessment"),
    layer("target cell", p.targetCell),
    layer("position", `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`),
    layer("GPS accuracy", p.gpsAccuracyM, " m"),
    layer("mapped lithology", p.lithology),
    layer("terrain morphology", p.terrainMorphology),
    layer("elevation", p.elevationM, " m"),
    layer("nearest mapped fault", p.faultDistanceM, " m"),
    layer("nearest geological contact", p.contactDistanceM, " m"),
    layer("nearest drainage channel", p.drainageDistanceM, " m"),
    "",
    "EVIDENCE LAYER STATUS — read these carefully, they are the honesty of the report",
    "  present     = this layer contributed",
    "  not_scored  = the data EXISTS and is deliberately not scored (say why if known)",
    "  none_here   = the layer is loaded; none of it is near this site",
    "  empty_layer = nobody has loaded this data yet",
    "  no_source   = this data does not exist anywhere in the system",
    ...p.coverage.map((c) => `  ${c.role}: ${c.status}`),
    "",
    "WHY THE ENGINE OFFERED THIS TARGET",
    ...(p.engineReasons.length > 0
      ? p.engineReasons.map((r) => `  - ${r}`)
      : ["  (no structured reasons recorded)"]),
    "",
    "WHAT THE GEOLOGIST RECORDED ON THE GROUND",
    ...(p.observations.length > 0
      ? p.observations.map((o) =>
          `  - ${o.type} (position ${o.positionQuality}, ${o.photoCount} photo(s)): ${o.notes || "no notes"}` +
          // Named, so a reading taken FROM an image can be tied back to it. A
          // Visual Evidence section that cannot say which photograph it is
          // talking about leaves the reader nothing to go and look at.
          (o.photoIds && o.photoIds.length > 0 ? `
      photographs: ${o.photoIds.join(", ")}` : ""))
      : ["  NOTHING RECORDED. This is itself a finding — say so plainly."]),
    `  photographs: ${p.photoCount}   track points: ${p.trackPoints}`,
    "",
    "OUTPUT — STRICT JSON, no markdown, no commentary:",
    "{",
    '  "interest": "notable|moderate|limited|none",',
    '  "confidence": "high|medium|low",   // how COMPLETE the evidence is, NOT a likelihood',
    '  "evidence": [{"type":"snake_case_code","origin":"field_observation|photograph|engine_layer|commodity_profile",',
    '               "status":"present|not_scored|none_here|empty_layer|no_source",',
    '               "strength":"strong|moderate|weak|absent","confidence":"high|medium|low",',
    '               "significance":"snake_case_code",',
    '               "photo_id":"the id above, ONLY when origin is photograph"}],',
    '  "missing_evidence": ["assay","geochemistry","..."],   // snake_case codes',
    "  // NOT requested: what to do next. That decision is made by a deterministic",
    "  // rule engine over structured evidence, not by you — anything you write here",
    "  // is discarded. Explain your reasoning in `narrative.interpretation` instead.",
    '  "narrative": {',
    '    "en": {"summary":"...","interpretation":"..."},',
    '    "so": {"summary":"...","interpretation":"..."}',
    "  }",
    "}",
    "",
    "The `type`, `significance`, `action` and `missing_evidence` values MUST be",
    "snake_case codes, never sentences — the app renders them in the reader's own",
    "language, so a sentence there cannot be translated.",
    "",
    "The narrative is the only prose. Write BOTH languages. The Somali must carry",
    "the same geological meaning at the same confidence — do not simplify it, do not",
    "soften it, do not strengthen it. Keep established technical terms in English in",
    "brackets where it helps, e.g. 'xidid quartz ah (quartz vein)', 'jeex (fault)',",
    "'isbeddel macdaneed (alteration)'.",
  ].join("\n");
}

// ── Parsing ─────────────────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
/**
 * snake_case codes only. A sentence here cannot be rendered in another language.
 *
 * REFUSING, not normalising. The first version of this lower-cased and replaced
 * every non-word character, which turned "There is a quartz vein visible on the
 * outcrop" into a plausible-looking `there_is_a_quartz_vein_visible_on_the_outcrop`
 * and accepted it. That defeats the purpose: the code is an i18n key, an English
 * sentence dressed as one renders as English to a Somali reader, and nothing
 * downstream can tell it was never a code.
 *
 * So a sentence is rejected and the item is dropped. Light normalisation of a
 * genuine short phrase is still allowed — a model writing "quartz vein" rather
 * than "quartz_vein" meant the code.
 */
const MAX_CODE_WORDS = 4;
function code(v: unknown): string {
  const raw = str(v);
  if (!raw) return "";
  // Sentence punctuation is never part of a code.
  if (/[.,;:!?()"'\/]/.test(raw)) return "";
  if (raw.split(/[\s_-]+/).filter(Boolean).length > MAX_CODE_WORDS) return "";
  const s = raw.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[a-z][a-z0-9_]{0,63}$/.test(s) ? s : "";
}
function pick<T extends string>(v: unknown, allowed: T[], fallback: T): T {
  const s = str(v).toLowerCase() as T;
  return allowed.includes(s) ? s : fallback;
}

export interface ParseResult {
  findings: MissionFindings | null;
  /** What was thrown away and why, so a bad model response is diagnosable. */
  discarded: string[];
}

/**
 * Read the model's answer, discarding anything it was not allowed to say.
 *
 * Never throws and never returns a partial object pretending to be complete: a
 * response that cannot be parsed yields null, and the mission stays unanalysed
 * rather than acquiring a hollow report.
 */
export function parseMissionFindings(
  text: string,
  meta: { model: string; commodity: string | null; analysedAt: number },
): ParseResult {
  const discarded: string[] = [];
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    return { findings: null, discarded: ["response was not JSON"] };
  }
  if (!obj || typeof obj !== "object") {
    return { findings: null, discarded: ["response was not an object"] };
  }

  // THE ENGINE BOUNDARY. Any score-like key is dropped and recorded, because a
  // number that exists will eventually be displayed, and then a validated model
  // has been replaced by a guess.
  for (const key of Object.keys(obj)) {
    if (REJECTED_KEYS.includes(key.toLowerCase())) {
      discarded.push(`refused key "${key}": the engine owns the score`);
      delete obj[key];
    }
  }

  const evidence: FindingEvidence[] = [];
  for (const raw of asArray(obj.evidence)) {
    const e = raw as Record<string, unknown>;
    const type = code(e.type);
    if (!type) {
      discarded.push(`evidence dropped: "${str(e.type)}" is not a snake_case code`);
      continue;
    }
    evidence.push({
      type,
      origin: pick(e.origin, ORIGINS, "engine_layer"),
      status: pick(e.status, STATUSES, "present"),
      strength: pick(e.strength, STRENGTHS, "weak"),
      confidence: pick(e.confidence, CONFIDENCES, "low"),
      significance: code(e.significance) || "unstated",
      // Kept only where it means something. A photo id on an engine layer is the
      // model having misunderstood the question, not a fact about an image.
      ...(typeof e.photo_id === "string" && e.photo_id.length > 0 &&
          pick(e.origin, ORIGINS, "engine_layer") === "photograph"
        ? { photoId: e.photo_id }
        : {}),
      ...(typeof e.value === "number" && Number.isFinite(e.value) ? { value: e.value } : {}),
    });
  }

  const missingEvidence: string[] = [];
  for (const raw of asArray(obj.missing_evidence)) {
    const c = code(raw);
    if (c) missingEvidence.push(c);
    else discarded.push(`missing_evidence dropped: "${str(raw)}" is not a code`);
  }

  const recommendations: FindingRecommendation[] = [];
  for (const raw of asArray(obj.recommendations)) {
    const r = raw as Record<string, unknown>;
    const action = code(r.action);
    if (!action) {
      discarded.push(`recommendation dropped: "${str(r.action)}" is not a code`);
      continue;
    }
    const p = Number(r.priority);
    recommendations.push({
      action,
      priority: p === 1 || p === 2 || p === 3 ? (p as 1 | 2 | 3) : 3,
      becauseOf: asArray(r.because_of).map(code).filter((c) => c.length > 0),
    });
  }

  const narrative = readNarrative(obj.narrative, discarded);

  const findings: MissionFindings = {
    version: MISSION_FINDINGS_VERSION,
    commodity: meta.commodity,
    interest: pick(obj.interest, INTERESTS, "limited"),
    // A model that omits confidence gets the cautious answer, not the flattering one.
    confidence: pick(obj.confidence, CONFIDENCES, "low"),
    evidence,
    missingEvidence,
    recommendations: recommendations.sort((a, b) => a.priority - b.priority),
    ...(narrative ? { narrative } : {}),
    model: meta.model,
    analysedAt: meta.analysedAt,
  };
  return { findings, discarded };
}

function readNarrative(
  raw: unknown,
  discarded: string[],
): Record<"en" | "so", { summary: string; interpretation: string }> | undefined {
  const n = (raw ?? {}) as Record<string, unknown>;
  const en = (n.en ?? {}) as Record<string, unknown>;
  const so = (n.so ?? {}) as Record<string, unknown>;
  const out = {
    en: { summary: str(en.summary), interpretation: str(en.interpretation) },
    so: { summary: str(so.summary), interpretation: str(so.interpretation) },
  };
  // Both languages or neither. One language present would hand a Somali reader an
  // English report, or an empty one — and the whole point of the structured
  // findings is that the report works without any prose at all.
  const complete = out.en.summary && out.so.summary;
  if (!complete) {
    if (out.en.summary || out.so.summary) {
      discarded.push("narrative dropped: only one language was returned");
    }
    return undefined;
  }
  return out;
}

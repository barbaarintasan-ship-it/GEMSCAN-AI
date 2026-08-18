// What the AI geologist concluded — as DATA, not as prose.
//
// THE RULE THIS SHAPE EXISTS TO ENFORCE
//
// A geologist must be able to switch the report between Somali and English with no
// model call, no waiting, and no possibility that the two versions say different
// things. That cannot be achieved by asking a model for two translations and
// hoping: it is achieved by making the FINDINGS language-free and rendering the
// text from them.
//
// So `strength`, `confidence`, `interest` and every evidence and recommendation
// item are codes. Switching language re-renders from the same codes, which means:
//
//   · language switching costs nothing and works offline
//   · confidence CANNOT differ between languages — there is one field
//   · the same evidence CANNOT produce a different conclusion in Somali
//
// This is the pattern the geological engine already uses (see
// mobile/lib/exploration/wording.ts): the engine emits what it found, the edge
// renders it in the reader's language.
//
// WHAT IS NOT REPRESENTABLE HERE
//
// There is no probability field. No "chance of discovery", no percentage, no
// "confirmed". The type system refuses them, so a prompt cannot be talked into
// producing one and a future edit cannot quietly add one without changing this
// file. `confidence` is how complete the evidence is, and it is an enum of three
// words — it is not a likelihood of finding a deposit, and the two must never be
// conflated.

/** How strongly a single piece of evidence bears on the assessment. */
export type EvidenceStrength = "strong" | "moderate" | "weak" | "absent";

/**
 * How complete the evidence is. NOT a probability of anything.
 *
 * An assessment can be HIGH confidence that a site is of limited interest. The
 * two axes are independent and are kept apart deliberately — collapsing them is
 * how an app starts telling people it is 70% sure there is gold.
 */
export type ConfidenceLevel = "high" | "medium" | "low";

/** How much geological interest the site holds. Also not a probability. */
export type GeologicalInterest = "notable" | "moderate" | "limited" | "none";

/** Where a piece of evidence came from. */
export type EvidenceOrigin =
  | "field_observation"   // the geologist recorded it
  | "photograph"          // read from an image
  | "engine_layer"        // the offline prospectivity engine
  | "commodity_profile";  // the selected commodity's own knowledge

/**
 * The state of an evidence layer, matching the engine's own vocabulary exactly.
 *
 * Reused rather than redefined so an AI report and the EVIDENCE BASIS panel can
 * never disagree about whether something was absent or never looked for.
 */
export type EvidenceStatus =
  | "present" | "not_scored" | "none_here" | "empty_layer" | "no_source";

export interface FindingEvidence {
  /**
   * A code, never a sentence — `quartz_vein`, `fault_proximity`, `valley_landform`.
   * Rendered through i18n at the edge.
   */
  type: string;
  origin: EvidenceOrigin;
  status: EvidenceStatus;
  strength: EvidenceStrength;
  confidence: ConfidenceLevel;
  /**
   * Why it matters, as a code. The reason a quartz vein is interesting does not
   * change with the reader's language, so it is not stored as text either.
   */
  significance: string;
  /**
   * The photograph this was read FROM, when it was read from one.
   *
   * Only ever set on `origin: "photograph"`. Without it the Visual Evidence
   * section could say what the images showed but not WHICH image showed it, and
   * a reader deciding whether to go back has no way to look at the one that
   * matters. The id is the device's own photo id — the same one the R2 key is
   * built from — so it resolves on the phone with no network.
   */
  photoId?: string;
  /** Measured quantity when there is one — a distance, a count. Unitless here. */
  value?: number;
  /**
   * For AI-vision evidence: the model that produced it, e.g. "gemini_vision".
   * Absent on field observations and engine layers, whose origin already says it.
   */
  source?: string;
  /**
   * For AI-vision evidence: how far the finding has been checked.
   *
   * Vision output is always "unverified" — a photograph can show a vein or a
   * stain, never prove mineralisation — so it can never stand in for assay or
   * geochemistry, and the report can say so. Absent on non-visual evidence.
   */
  verificationStatus?: "unverified" | "photo_present" | "assay_verified";
}

export interface FindingRecommendation {
  /** A code: `collect_rock_samples`, `record_vein_orientation`, `submit_for_assay`. */
  action: string;
  /** 1 is do-first. Ordering is part of the advice, not a display choice. */
  priority: 1 | 2 | 3;
  /** The evidence codes that prompted it, so advice is always traceable. */
  becauseOf: string[];
}

/**
 * Free prose, per language, produced in the SAME model call.
 *
 * Secondary to the structure above and constrained by it: the narrative may
 * explain the findings, never add to them. Optional, because a report is complete
 * without it — the sections that carry the geology are all rendered from codes.
 */
export interface FindingNarrative {
  summary: string;
  interpretation: string;
}

export const MISSION_FINDINGS_VERSION = 1;

export interface MissionFindings {
  version: number;
  /** The commodity the assessment was conditioned on, or null for universal. */
  commodity: string | null;
  interest: GeologicalInterest;
  /** How complete the evidence is. See ConfidenceLevel. */
  confidence: ConfidenceLevel;
  /**
   * What the model claimed before the evidence ceiling was applied.
   *
   * Set only when the two differ. Kept because the reduction is information the
   * reader is entitled to — a model that reported HIGH on two observations and no
   * assay has told you something about itself — and because capping in the pipeline
   * and comparing in the renderer otherwise destroys the very fact being reported.
   */
  claimedConfidence?: ConfidenceLevel;
  evidence: FindingEvidence[];
  /**
   * What was NOT available, as codes — `geochemistry`, `assay`, `alteration_mapping`.
   *
   * Required to be non-empty in practice and never silently omitted: a report that
   * lists only what was found reads as a complete picture, and in greenfield
   * exploration it never is.
   */
  missingEvidence: string[];
  recommendations: FindingRecommendation[];
  /** Optional prose in both languages. The findings do not depend on it. */
  narrative?: Record<"en" | "so", FindingNarrative>;
  /** Which model produced this, so an assessment can be re-read against its author. */
  model: string;
  analysedAt: number;
}

// ── Guards ──────────────────────────────────────────────────────────────────

/**
 * Phrases that must never reach a user, in either language.
 *
 * The type system stops a probability FIELD; this stops a probability SENTENCE
 * smuggled into the narrative. Both are needed: a model told not to give odds
 * will sometimes write them into prose instead, and prose is what people read.
 */
const FORBIDDEN = [
  // English
  /\b\d{1,3}\s*%/,
  /\b\d{1,3}\s*percent\b/i,
  /\bprobabilit/i,
  /\bchance\s+of\b/i,
  /\bodds\b/i,
  /\blikelihood\b/i,
  /\bguarantee/i,
  /\bconfirmed\s+(gold|silver|copper|deposit|mineralisation|mineralization)\b/i,
  /\bdefinitely\b/i,
  /\bcertain(ly)?\s+(gold|deposit)\b/i,
  // Somali — matched on STEMS, with no closing word boundary.
  //
  // Somali is agglutinative: "suurtagalnimo" becomes "suurtagalnimada" the moment
  // it takes an article, and "boqolkiiba" becomes "boqolkiibaas". A pattern
  // anchored at the end of the word caught none of those, which meant the guard
  // read English and waved the identical claim through in the language most of
  // these readers actually use. That is the worse failure of the two.
  /\bboqolkiib/i,
  /\bsuurtagalnim/i,
  /\bsuurtogalnim/i,
  /\bihtimaal/i,
  /\bhubaal\s+\w*\s*(dahab|macdan|lacag)/i,
  /\bxaqiijis\w*\s+\w*\s*(dahab|macdan)/i,
  /\bdam+aanad/i,
];

export interface LanguageViolation {
  where: string;
  phrase: string;
}

/**
 * Find probability or certainty language anywhere in a narrative.
 *
 * Returns what it found rather than a boolean, so a caller can log the actual
 * phrase — "the model produced forbidden language" with no example is a bug report
 * nobody can act on.
 */
export function findForbiddenLanguage(f: MissionFindings): LanguageViolation[] {
  const out: LanguageViolation[] = [];
  if (!f.narrative) return out;
  for (const [lang, n] of Object.entries(f.narrative)) {
    for (const [field, text] of Object.entries(n)) {
      for (const pattern of FORBIDDEN) {
        const m = pattern.exec(text);
        if (m) out.push({ where: `${lang}.${field}`, phrase: m[0] });
      }
    }
  }
  return out;
}

/**
 * Strip the narrative if it breaks the language rule, keeping the findings.
 *
 * The structured findings are the report; the prose is a convenience. So a model
 * that writes "70% chance" loses its paragraph and the geologist still gets the
 * full assessment, rendered from codes. Discarding the whole analysis over a
 * sentence would punish the user for the model's mistake.
 */
export function withoutForbiddenNarrative(
  f: MissionFindings,
): { findings: MissionFindings; violations: LanguageViolation[] } {
  const violations = findForbiddenLanguage(f);
  if (violations.length === 0) return { findings: f, violations };
  const { narrative: _dropped, ...rest } = f;
  return { findings: rest, violations };
}

/**
 * Is this a usable assessment?
 *
 * An analysis with no evidence and no stated gaps is not a cautious report, it is
 * an empty one, and shipping it would teach a geologist that the app has an
 * opinion where it has none.
 */
export function isUsableFindings(f: MissionFindings): boolean {
  return f.version === MISSION_FINDINGS_VERSION &&
    (f.evidence.length > 0 || f.missingEvidence.length > 0) &&
    f.model.length > 0;
}

/**
 * Confidence follows the evidence, and is checked rather than trusted.
 *
 * A model asked for a confidence level will sometimes return HIGH on a mission
 * with two observations and no assay. This is the arithmetic it should have done:
 * confidence is capped by what is actually present, so the label can never
 * outrun the evidence behind it.
 */
export function cappedConfidence(f: MissionFindings): ConfidenceLevel {
  const present = f.evidence.filter((e) => e.status === "present").length;
  const strong = f.evidence.filter((e) => e.strength === "strong").length;
  // No assay and no geochemistry is the normal greenfield case, and it means the
  // ceiling is MEDIUM however good the field observations look.
  const hasLabWork = !f.missingEvidence.includes("assay") &&
    !f.missingEvidence.includes("geochemistry");

  let ceiling: ConfidenceLevel = "low";
  if (present >= 5 && strong >= 2 && hasLabWork) ceiling = "high";
  else if (present >= 3) ceiling = "medium";

  const order: ConfidenceLevel[] = ["low", "medium", "high"];
  return order[Math.min(order.indexOf(f.confidence), order.indexOf(ceiling))];
}

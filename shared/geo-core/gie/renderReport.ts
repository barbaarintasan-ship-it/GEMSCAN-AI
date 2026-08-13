// Turning language-free findings into a report someone can read.
//
// This is the half that makes switching language free. The findings are codes; this
// renders them through the caller's own translator, so Somali and English are two
// renderings of one assessment rather than two assessments. There is no model call
// here, no network, and nothing that can differ between the two languages except
// the words.
//
// Runs on the device (the report screen) and could run on the server (a PDF) from
// the same findings, which is why it lives in shared/ and takes the translator as
// an argument instead of importing one.
//
// AN UNKNOWN CODE MUST NEVER RENDER AS BLANK
//
// A model can emit a code nothing has a translation for. The wrong answers are an
// empty line, or the raw `hydrothermal_indicator` shown to a Somali reader as
// though it were Somali. So an untranslated code is humanised AND reported in
// `untranslated`, which gives the app a way to notice and the reader something
// meaningful to look at meanwhile.
import {
  cappedConfidence,
  type ConfidenceLevel, type FindingEvidence, type GeologicalInterest,
  type MissionFindings,
} from "./missionFindings.ts";

/** The caller's translator. Missing keys must come back as the key itself. */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

export type ReportLanguage = "en" | "so";

export interface ReportSection {
  /** i18n key for the heading. */
  titleKey: string;
  title: string;
  lines: string[];
}

export interface RenderedReport {
  language: ReportLanguage;
  /** Rendered from the codes; identical in substance across languages by construction. */
  sections: ReportSection[];
  /**
   * The confidence actually shown — `cappedConfidence`, not the model's raw claim.
   *
   * One value, language-free, so it cannot differ between renderings.
   */
  confidence: ConfidenceLevel;
  interest: GeologicalInterest;
  /** Codes that had no translation. Empty is the goal; non-empty is actionable. */
  untranslated: string[];
}

/** `hydrothermal_indicator` → `Hydrothermal indicator`. A last resort, never blank. */
export function humanise(code: string): string {
  const s = code.replace(/_/g, " ").trim();
  return s.length === 0 ? code : s[0].toUpperCase() + s.slice(1);
}

const ORDER: ReadonlyArray<FindingEvidence["strength"]> = ["strong", "moderate", "weak", "absent"];

/**
 * Render the six sections a field report needs.
 *
 * The order is deliberate: what was found, then what it might mean, then what is
 * MISSING, then what to do about it. Putting the gaps before the advice is the
 * difference between a report and a sales pitch.
 */
export function renderReport(
  f: MissionFindings,
  t: Translate,
  language: ReportLanguage,
  /** The engine's score, passed IN. The analysis never carries one. */
  engine: { prospectivityScore: number },
): RenderedReport {
  const untranslated: string[] = [];
  const tr = (key: string, code: string, params?: Record<string, string | number>): string => {
    const out = t(key, params);
    // A translator that returns the key unchanged has no entry for it.
    if (out === key || out.length === 0) {
      untranslated.push(code);
      return humanise(code);
    }
    return out;
  };

  const confidence = cappedConfidence(f);

  // 1 — Executive summary. The narrative when there is one, otherwise built from
  // the codes, because a report must be complete with no prose at all.
  const summary = f.narrative?.[language]?.summary;
  const summaryLines = summary
    ? [summary]
    : [
        t("report.summary.generated", {
          interest: t(`report.interest.${f.interest}`),
          confidence: t(`report.confidence.${confidence}`),
          found: String(f.evidence.filter((e) => e.status === "present").length),
          missing: String(f.missingEvidence.length),
        }),
      ];

  // 2 — The engine's ranking, restated as what it is and is not.
  const scoreLines = [
    t("report.score.value", { score: engine.prospectivityScore.toFixed(2) }),
    t("report.score.notAProbability"),
    f.commodity
      ? t("report.score.commodity", { commodity: t(`commodity.${f.commodity}`) })
      : t("report.score.universal"),
  ];

  // 3 — Evidence, strongest first, each with its status and why it matters.
  //
  // SPLIT BY ORIGIN, because a geologist's own observation and a layer the engine
  // read off a map are not the same kind of claim, and a reader deciding whether
  // to go back deserves to see which is which. `EvidenceOrigin` already carried
  // the distinction; it was simply being thrown away in one flat list.
  //
  //   field_observation  → what the geologist recorded, standing there
  //   photograph         → what was read from an image
  //   engine_layer       → the offline engine's own reading of the ground
  //   commodity_profile  → what the selected commodity's knowledge implies
  const evidence = [...f.evidence].sort(
    (a, b) => ORDER.indexOf(a.strength) - ORDER.indexOf(b.strength),
  );
  const evidenceRow = (e: FindingEvidence) =>
    t("report.evidence.row", {
      name: tr(`report.evidenceType.${e.type}`, e.type),
      status: t(`field.coverage.${e.status}`),
      strength: t(`report.strength.${e.strength}`),
      reason: tr(`report.significance.${e.significance}`, e.significance),
    });

  const observed = evidence.filter((e) => e.origin === "field_observation");
  const visual = evidence.filter((e) => e.origin === "photograph");
  const context = evidence.filter(
    (e) => e.origin === "engine_layer" || e.origin === "commodity_profile",
  );

  const observedLines = observed.length > 0
    ? observed.map(evidenceRow)
    : [t("report.observations.none")];
  // Each visual reading is labelled with the photograph it came from, so a reader
  // deciding whether to go back has something to go and look at. The id is the
  // device's own — the same one the file on the phone is named after — so it
  // resolves offline.
  const visualLines = visual.length > 0
    ? visual.map((e) => (e.photoId
        ? `${t("report.visual.photo", { id: e.photoId })} ${evidenceRow(e)}`
        : evidenceRow(e)))
    : [t("report.visual.none")];
  const contextLines = context.length > 0
    ? context.map(evidenceRow)
    : [t("report.context.none")];

  // Kept so nothing is lost if an origin is added and not yet given a home.
  const uncategorised = evidence.filter(
    (e) => !observed.includes(e) && !visual.includes(e) && !context.includes(e),
  );
  if (uncategorised.length > 0) observedLines.push(...uncategorised.map(evidenceRow));

  // 4 — What is NOT here. Stated as its own section, never folded into a caveat at
  // the end: in greenfield exploration most evidence is absent, and a report that
  // lists only what was found reads as a complete picture.
  const missingLines = f.missingEvidence.length > 0
    ? f.missingEvidence.map((m) => `${"•"} ${tr(`report.missing.${m}`, m)}`)
    : [t("report.missing.none")];

  // 5 — What to do next, in the priority the analysis gave.
  const actionLines = f.recommendations.length > 0
    ? f.recommendations.map((r, i) =>
        t("report.action.row", {
          n: i + 1,
          action: tr(`report.action.${r.action}`, r.action),
        }))
    : [t("report.action.none")];

  // 6 — Confidence, and what it does and does not mean.
  const confidenceLines = [
    t("report.confidence.value", { confidence: t(`report.confidence.${confidence}`) }),
    t("report.confidence.meaning"),
  ];
  // Said out loud when the model's claim was higher than the evidence allows.
  // `claimedConfidence` is set by the pipeline at the moment it caps, because by
  // the time a report is rendered the original claim is otherwise gone.
  const claimed = f.claimedConfidence;
  if (claimed && claimed !== confidence) {
    confidenceLines.push(t("report.confidence.capped", {
      claimed: t(`report.confidence.${claimed}`),
    }));
  }

  const interpretation = f.narrative?.[language]?.interpretation;

  // THE SIX SECTIONS OF A FIELD REPORT, in the order a geologist reads one.
  //
  //   1 Overview             what was investigated, and the engine's own ranking
  //   2 Field observations   what the geologist recorded on the ground
  //   3 Visual evidence      what the photographs show
  //   4 Geological context   what the engine and the commodity knowledge say
  //   5 Possible interpretation  cautiously, and only ever as a possibility
  //   6 Recommended next steps
  //
  // What is missing, and how confident the reading is, stay as their own sections
  // AFTER the interpretation rather than being folded into it as caveats — in
  // greenfield exploration most evidence is absent, and a report that lists only
  // what was found reads as a complete picture.
  const sections: ReportSection[] = [
    section("report.section.overview", t, [...summaryLines, ...scoreLines]),
    section("report.section.observations", t, observedLines),
    section("report.section.visual", t, visualLines),
    section("report.section.context", t, contextLines),
    ...(interpretation ? [section("report.section.interpretation", t, [interpretation])] : []),
    section("report.section.missing", t, missingLines),
    section("report.section.actions", t, actionLines),
    section("report.section.confidence", t, confidenceLines),
  ];

  return { language, sections, confidence, interest: f.interest, untranslated };
}

function section(titleKey: string, t: Translate, lines: string[]): ReportSection {
  return { titleKey, title: t(titleKey), lines };
}

/**
 * Do two renderings of the same findings agree on the geology?
 *
 * A test helper AND a runtime check worth having: it compares everything that is
 * not prose. If this ever returns false, the two languages are telling a geologist
 * different things, which is the failure the whole structured design exists to make
 * impossible.
 */
export function renderingsAgree(a: RenderedReport, b: RenderedReport): boolean {
  return a.confidence === b.confidence &&
    a.interest === b.interest &&
    a.sections.length === b.sections.length &&
    a.sections.every((s, i) =>
      s.titleKey === b.sections[i].titleKey && s.lines.length === b.sections[i].lines.length);
}

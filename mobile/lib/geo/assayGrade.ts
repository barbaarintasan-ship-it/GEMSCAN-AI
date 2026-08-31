// Grade-aware assay interpretation (Architecture: Integrated Prospectivity
// Score, Priority 2).
//
// THE PROBLEM THIS FIXES: assaysToObservations() (structuredEvidenceSource.ts)
// gave every reported result the same flat ASSAY_WEIGHT — 0.05 g/t Au and 30
// g/t Au moved the score by an identical amount. For an app whose purpose is
// helping someone interpret an assay, that is not a nuance, it is a gap.
//
// WHAT THIS DOES NOT DO, and why. It does NOT define a universal economic
// cut-off grade — "economic" depends on mining method, location, metal price
// and deposit geometry, none of which this app knows, and asserting one would
// be exactly the kind of fabricated threshold the rest of this codebase
// refuses to invent (see commodityModel.ts's own EvidenceBasis doctrine).
//
// What it DOES define is a small, explicitly-labelled EXPLORATION GEOCHEMISTRY
// CONVENTION — the ordinary bands a field geologist already uses to read a
// number before a lab report exists ("that's just background," "that's worth
// following up," "that's a bonanza intercept") — for the ONLY two commodities
// this review scoped (gold, tin), in the units their own assay forms actually
// use. Every band is a widely-published exploration-geochemistry convention,
// not a number fitted to this pack's data and not an economic threshold.
//
// ANY commodity/element/unit combination NOT in GRADE_CONVENTIONS returns
// "unclassified" — the assay's WEIGHT stays exactly as flat as it always was
// (today's ASSAY_WEIGHT, unmodified), and the value itself is still shown in
// the report. Unclassified is the honest default, not a bug.
export type GradeBand = "trace" | "low" | "moderate" | "high" | "exceptional" | "unclassified";

/**
 * Multiplies the assay's base weight. Bounded to the SAME [0.5, 1.5] range
 * commodityModel.ts already uses for its own factor bounds — reused, not a
 * new scale invented for this one purpose.
 */
export const GRADE_BAND_FACTOR: Record<GradeBand, number> = {
  trace: 0.5,
  low: 0.75,
  moderate: 1.0,
  high: 1.25,
  exceptional: 1.5,
  unclassified: 1.0,
};

interface GradeBandThreshold {
  /** Inclusive upper bound for this band, ascending order, in `unit`. */
  upTo: number;
  band: GradeBand;
}

interface GradeConvention {
  unit: string;
  /** Ascending by `upTo`; the last entry's `upTo` should be Infinity. */
  thresholds: readonly GradeBandThreshold[];
}

/**
 * Standard exploration-geochemistry bands. Every number here is a widely-cited
 * industry convention (not fitted to this pack, not an economic cut-off):
 *
 *   Au (g/t)  <0.1 trace / 0.1-1 low / 1-5 moderate / 5-15 high / >15 exceptional
 *             — roughly what exploration geochemistry treats as background,
 *             weakly anomalous, anomalous, high-grade, and bonanza respectively.
 *   Sn (%)    <0.01 trace / 0.01-0.1 low / 0.1-0.5 moderate / 0.5-1 high / >1 exceptional
 *             — cassiterite concentrations conventionally read the same way.
 */
const GRADE_CONVENTIONS: Record<string, GradeConvention> = {
  au: {
    unit: "g/t",
    thresholds: [
      { upTo: 0.1, band: "trace" },
      { upTo: 1, band: "low" },
      { upTo: 5, band: "moderate" },
      { upTo: 15, band: "high" },
      { upTo: Infinity, band: "exceptional" },
    ],
  },
  sn: {
    unit: "%",
    thresholds: [
      { upTo: 0.01, band: "trace" },
      { upTo: 0.1, band: "low" },
      { upTo: 0.5, band: "moderate" },
      { upTo: 1, band: "high" },
      { upTo: Infinity, band: "exceptional" },
    ],
  },
};

/** Common ways a geologist might type the element. Aliases only — no new elements added. */
const ELEMENT_ALIASES: Record<string, string> = {
  au: "au", gold: "au", dahab: "au",
  sn: "sn", tin: "sn", qalin: "sn",
};

/**
 * Classify one assay result into an exploration-geochemistry band.
 *
 * Returns "unclassified" whenever it cannot classify HONESTLY: no convention
 * for this element, the reported unit doesn't match the convention's unit (no
 * silent g/t<->% conversion — that requires a density assumption this
 * function has no basis to make), or the number itself is not a real reading
 * (non-finite, negative — a lab does not report negative concentration, so a
 * negative value is a data-entry problem, not evidence of anything).
 */
export function classifyGrade(element: string, result: number, unit: string): GradeBand {
  if (!Number.isFinite(result) || result < 0) return "unclassified";
  const key = ELEMENT_ALIASES[element.trim().toLowerCase()];
  if (!key) return "unclassified";
  const conv = GRADE_CONVENTIONS[key];
  if (!conv || conv.unit !== unit) return "unclassified";
  for (const t of conv.thresholds) if (result <= t.upTo) return t.band;
  return "unclassified";
}

/** Whether `element` has ANY grade convention defined, regardless of unit. */
export function hasGradeConvention(element: string): boolean {
  const key = ELEMENT_ALIASES[element.trim().toLowerCase()];
  return key != null && GRADE_CONVENTIONS[key] != null;
}

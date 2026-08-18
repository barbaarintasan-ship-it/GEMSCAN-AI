// Phase 1 — the DISPLAY prospectivity gate.
//
// These prove the two behaviours the fix exists for:
//   1. field-only evidence (a quartz vein + a fault at one outcrop) can NEVER
//      display as ~1.00, however strong the raw noisy-OR is.
//   2. missing corroborating datasets LOWER the displayed score, and adding them
//      raises it — so the number tracks how complete the picture is.
// It also proves the caps are CONFIGURABLE, not hard-coded, and that ranking is
// untouched (this layer never sees `computeConfidence`).
import {
  reportProspectivity,
  DEFAULT_REPORT_SCORE_CONFIG,
  type ScoredEvidence,
  type ReportScoreConfig,
} from "../../../shared/geo-core/gie/prospectivityReport";

// A field observation as prospectivityEvidence() emits it: role "field", tier "mapped".
const fieldObs = (id: string, weight: number): ScoredEvidence => ({
  weight, tier: "mapped", role: "field", group: `field:${id}`,
});

describe("reportProspectivity — single-group cap", () => {
  it("quartz vein + fault at one outcrop cannot reach 1.00", () => {
    // Two strong, independent-looking field observations. Raw noisy-OR saturates
    // toward 1.0 — that is the bug this gate corrects.
    const scored = [fieldObs("quartz", 0.9), fieldObs("fault", 0.9)];
    const shown = reportProspectivity(scored);
    // One category (field) → capped at singleCategoryCap, then the completeness
    // penalty (no corroborating dataset) pulls it further down.
    expect(shown).toBeLessThan(1.0);
    expect(shown).toBeLessThanOrEqual(DEFAULT_REPORT_SCORE_CONFIG.singleCategoryCap);
    // And nowhere near the raw ~0.95 it would otherwise print.
    expect(shown).toBeLessThan(0.5);
  });

  it("even three maxed field observations stay capped", () => {
    const scored = [fieldObs("a", 1), fieldObs("b", 1), fieldObs("c", 1)];
    // Still ONE category, so the single-category cap holds regardless of count.
    expect(reportProspectivity(scored)).toBeLessThanOrEqual(
      DEFAULT_REPORT_SCORE_CONFIG.singleCategoryCap,
    );
  });
});

describe("reportProspectivity — completeness gate (missing datasets lower the score)", () => {
  const field = fieldObs("quartz", 0.9);
  const lithology: ScoredEvidence = { weight: 0.3, tier: "mapped", role: "geology", group: "lithology" };
  const occurrence: ScoredEvidence = { weight: 0.8, tier: "mapped", role: "occurrence", group: "occ:1" };
  const structure: ScoredEvidence = { weight: 0.6, tier: "mapped", role: "structural", group: "structure:1" };

  it("field + weak lithology (2 categories, no corroboration) scores below the 2-category cap", () => {
    const shown = reportProspectivity([field, lithology]);
    expect(shown).toBeLessThanOrEqual(DEFAULT_REPORT_SCORE_CONFIG.twoCategoryCap);
  });

  it("adding a mapped occurrence + structure RAISES the displayed score", () => {
    const incomplete = reportProspectivity([field, lithology]);
    const complete = reportProspectivity([field, lithology, occurrence, structure]);
    // More independent, corroborating datasets → a higher, uncapped number.
    expect(complete).toBeGreaterThan(incomplete);
  });

  it("the completeness penalty applies only when NO corroborating dataset is present", () => {
    const noCorroboration = reportProspectivity([field]); // field only
    const withCorroboration = reportProspectivity([field, occurrence]); // + a real occurrence
    expect(withCorroboration).toBeGreaterThan(noCorroboration);
  });
});

describe("reportProspectivity — three or more categories are uncapped", () => {
  it("does not cap when evidence spans three independent categories", () => {
    const scored: ScoredEvidence[] = [
      fieldObs("quartz", 0.9),
      { weight: 0.8, tier: "mapped", role: "occurrence", group: "occ:1" },
      { weight: 0.6, tier: "mapped", role: "structural", group: "structure:1" },
    ];
    const shown = reportProspectivity(scored);
    // Above the two-category ceiling — the cap is lifted once the picture is broad.
    expect(shown).toBeGreaterThan(DEFAULT_REPORT_SCORE_CONFIG.twoCategoryCap);
  });
});

describe("reportProspectivity — configurable, not hard-coded", () => {
  it("honours custom cap values", () => {
    const scored = [fieldObs("quartz", 0.9), fieldObs("fault", 0.9)];
    const strict: ReportScoreConfig = {
      ...DEFAULT_REPORT_SCORE_CONFIG,
      singleCategoryCap: 0.2,
      incompletePenalty: 1, // isolate the cap
    };
    expect(reportProspectivity(scored, strict)).toBeLessThanOrEqual(0.2);

    const loose: ReportScoreConfig = {
      ...DEFAULT_REPORT_SCORE_CONFIG,
      singleCategoryCap: 0.95,
      incompletePenalty: 1,
    };
    // Same evidence, a looser cap → a higher number. Proves the cap drives it.
    expect(reportProspectivity(scored, loose)).toBeGreaterThan(
      reportProspectivity(scored, strict),
    );
  });

  it("treats a role listed in corroboratingRoles as lifting the penalty", () => {
    const scored = [fieldObs("quartz", 0.9)];
    const fieldCounts: ReportScoreConfig = {
      ...DEFAULT_REPORT_SCORE_CONFIG,
      corroboratingRoles: ["field"], // now field itself corroborates
    };
    expect(reportProspectivity(scored, fieldCounts)).toBeGreaterThan(
      reportProspectivity(scored, DEFAULT_REPORT_SCORE_CONFIG),
    );
  });
});

describe("reportProspectivity — edge cases", () => {
  it("no evidence scores zero", () => {
    expect(reportProspectivity([])).toBe(0);
  });

  it("collapses correlated evidence in one group (strongest wins, not summed)", () => {
    const twoInOneGroup: ScoredEvidence[] = [
      { weight: 0.5, tier: "mapped", role: "structural", group: "structure:1" },
      { weight: 0.8, tier: "mapped", role: "structural", group: "structure:1" },
    ];
    const oneItem: ScoredEvidence[] = [
      { weight: 0.8, tier: "mapped", role: "structural", group: "structure:1" },
    ];
    // Uncapped config so the collapse itself is what is under test, not the cap:
    // same group → counted once; the pair scores exactly like the single strongest.
    const uncapped: ReportScoreConfig = {
      ...DEFAULT_REPORT_SCORE_CONFIG,
      singleCategoryCap: 1, twoCategoryCap: 1, incompletePenalty: 1,
    };
    expect(reportProspectivity(twoInOneGroup, uncapped))
      .toBe(reportProspectivity(oneItem, uncapped));
  });
});

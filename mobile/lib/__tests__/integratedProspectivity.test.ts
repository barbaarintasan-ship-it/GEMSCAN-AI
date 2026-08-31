// Stage 1 — pure integrated-prospectivity math. No wiring, no UI, nothing live
// touched. These prove:
//   1. INTEGRATED_TIER_WEIGHT reproduces TIER_WEIGHT's five original entries
//      byte-for-byte (the baseline-preservation contract for the tier table).
//   2. With no new evidence, computeIntegratedProspectivity() is identical to
//      computeConfidence() on the same input.
//   3. New evidence raises the score, through the extended tiers, and stays
//      bounded (never > 1, AI-visual never dominates).
//   4. Grouping collapses a genuine restatement and keeps distinct findings apart.
import { TIER_WEIGHT, computeConfidence } from "../../../shared/geo-core/confidence";
import {
  INTEGRATED_TIER_WEIGHT,
  computeIntegratedProspectivity,
  aiVisualWeight,
  AI_VISUAL_WEIGHT_CEILING,
  canonicalWaypointType,
  canonicalVisualType,
  evidenceGroupKey,
  NEGATIVE_DAMPING_CEILING,
} from "../../../shared/geo-core/gie/integratedProspectivity";
import type { ScoredEvidence } from "../../../shared/geo-core/gie/prospectivityReport";
import type { EvidenceItem } from "../../../shared/geo-core/types";

describe("INTEGRATED_TIER_WEIGHT — extends, never edits, the baseline table", () => {
  it("reproduces all five original TIER_WEIGHT entries exactly", () => {
    for (const key of Object.keys(TIER_WEIGHT)) {
      expect(INTEGRATED_TIER_WEIGHT[key]).toBe(TIER_WEIGHT[key]);
    }
  });

  it("adds exactly the five new tiers the plan specifies", () => {
    expect(INTEGRATED_TIER_WEIGHT.verified_geophysics).toBe(0.8);
    expect(INTEGRATED_TIER_WEIGHT.expert_field).toBe(0.75);
    expect(INTEGRATED_TIER_WEIGHT.remote_sensing).toBe(0.6);
    expect(INTEGRATED_TIER_WEIGHT.user_reported).toBe(0.55);
    expect(INTEGRATED_TIER_WEIGHT.ai_visual).toBe(0.4);
  });
});

describe("computeIntegratedProspectivity — baseline equivalence", () => {
  const baselineFault: ScoredEvidence = { weight: 0.6, tier: "mapped", role: "structural", group: "structure:1" };
  const baselineLithology: ScoredEvidence = { weight: 0.25, tier: "mapped", role: "geology", group: "lithology" };
  const baselineCommunity: ScoredEvidence = { weight: 0.4, tier: "community", role: "community", group: "community" };

  it("with no new evidence, matches computeConfidence() on the same items", () => {
    const scored = [baselineFault, baselineLithology, baselineCommunity];
    const asEvidenceItems: EvidenceItem[] = scored.map((s) => ({
      statement: s.group, weight: s.weight, tier: s.tier,
    }));
    const baseline = computeConfidence(asEvidenceItems).score;
    const integrated = computeIntegratedProspectivity(scored);
    expect(integrated).toBe(baseline);
  });

  it("no evidence at all scores zero, same as the baseline engine", () => {
    expect(computeIntegratedProspectivity([])).toBe(0);
    expect(computeConfidence([]).score).toBe(0);
  });
});

describe("computeIntegratedProspectivity — new evidence raises the score, stays bounded", () => {
  const baseline: ScoredEvidence = { weight: 0.3, tier: "mapped", role: "geology", group: "lithology" };

  it("adding a user-reported item raises the score above baseline alone", () => {
    const withoutNew = computeIntegratedProspectivity([baseline]);
    const userItem: ScoredEvidence = {
      weight: 0.5, tier: "user_reported", role: "field", group: "evidence:wp-1:quartz_vein",
    };
    const withNew = computeIntegratedProspectivity([baseline, userItem]);
    expect(withNew).toBeGreaterThan(withoutNew);
  });

  it("a lab_verified item contributes more strongly than the same weight at user_reported", () => {
    const lab: ScoredEvidence = { weight: 0.5, tier: "lab_verified", role: "geochemistry", group: "evidence:s-1:assay" };
    const userReported: ScoredEvidence = { weight: 0.5, tier: "user_reported", role: "geochemistry", group: "evidence:s-1:assay" };
    expect(computeIntegratedProspectivity([lab])).toBeGreaterThan(computeIntegratedProspectivity([userReported]));
  });

  it("never exceeds 1, even with many maxed-out items", () => {
    const many: ScoredEvidence[] = Array.from({ length: 10 }, (_, i) => ({
      weight: 1, tier: "lab_verified", role: "geochemistry", group: `evidence:s-${i}:assay`,
    }));
    expect(computeIntegratedProspectivity(many)).toBeLessThanOrEqual(1);
  });

  it("a single AI-visual item never dominates the score on its own", () => {
    const aiOnly: ScoredEvidence = {
      weight: aiVisualWeight(1, 1, "mineral"), tier: "ai_visual", role: "field", group: "evidence:wp-1:native_metal",
    };
    const score = computeIntegratedProspectivity([aiOnly]);
    // Even at maximal clarity/quality on the strongest aspect, the effective
    // contribution is bounded well below what a real occurrence/lab result gives.
    expect(score).toBeLessThan(0.15);
  });
});

describe("aiVisualWeight — bounded, never a pass-through of AI confidence", () => {
  it("caps at AI_VISUAL_WEIGHT_CEILING x the aspect base weight, regardless of stated clarity", () => {
    const w = aiVisualWeight(1, 1, "mineral");
    expect(w).toBeLessThanOrEqual(AI_VISUAL_WEIGHT_CEILING);
    // 0.95-style "AI confidence" must not read as anywhere near 0.95 of weight.
    expect(w).toBeLessThan(0.5);
  });

  it("scales down with clarity and image quality", () => {
    const clear = aiVisualWeight(1, 1, "vein");
    const blurry = aiVisualWeight(0.3, 0.5, "vein");
    expect(blurry).toBeLessThan(clear);
  });

  it("an unknown aspect falls back to the weakest (\"other\") base weight, not the strongest", () => {
    const known = aiVisualWeight(1, 1, "mineral");
    const unknown = aiVisualWeight(1, 1, "not-a-real-aspect");
    expect(unknown).toBeLessThan(known);
  });

  it("zero clarity or zero image quality yields zero weight", () => {
    expect(aiVisualWeight(0, 1, "mineral")).toBe(0);
    expect(aiVisualWeight(1, 0, "mineral")).toBe(0);
  });
});

describe("evidence grouping — double-count prevention", () => {
  it("a field quartz-vein tap and an AI-read quartz vein collapse to the same group", () => {
    const fieldType = canonicalWaypointType("quartz-vein");
    const visualType = canonicalVisualType("vein", "Clear quartz vein exposed in outcrop");
    expect(evidenceGroupKey("wp-1", fieldType)).toBe(evidenceGroupKey("wp-1", visualType));
  });

  it("a field quartz-vein tap and an AI-read \"visible native gold\" stay independent", () => {
    const fieldType = canonicalWaypointType("quartz-vein");
    const visualType = canonicalVisualType("mineral", "Visible metallic yellow material consistent with native gold");
    expect(evidenceGroupKey("wp-1", fieldType)).not.toBe(evidenceGroupKey("wp-1", visualType));
  });

  it("the same finding at two DIFFERENT sites does not collapse", () => {
    const type = canonicalWaypointType("sulfides");
    expect(evidenceGroupKey("wp-1", type)).not.toBe(evidenceGroupKey("wp-2", type));
  });

  it("an AI aspect with no keyword match falls back to its aspect bucket, not \"other\"", () => {
    expect(canonicalVisualType("alteration", "Faint reddish discolouration on the surface")).toBe("alteration");
  });

  it("gossan keywords refine weathering/alteration aspects to a shared \"gossan\" type", () => {
    expect(canonicalVisualType("weathering", "Rusty iron-stained gossan cap")).toBe("gossan");
    expect(canonicalVisualType("alteration", "Gossan development along the contact")).toBe("gossan");
  });

  it("unmapped waypoint types fall back to \"other\", never a false match", () => {
    expect(canonicalWaypointType("sample-location")).toBe("other");
  });
});

// ── Priority 1: negative / disconfirming evidence ────────────────────────
//
// Scenarios A-K per the approved implementation instruction.
describe("computeIntegratedProspectivity — negative evidence", () => {
  const strongPositive: ScoredEvidence[] = [
    { weight: 0.7, tier: "mapped", role: "structural", group: "structure:1" },
    { weight: 0.7, tier: "expert_field", role: "field", group: "evidence:s1:quartz_vein" },
    { weight: 0.85, tier: "expert_field", role: "field", group: "evidence:s1:sulfides" },
  ];
  const weakPositive: ScoredEvidence[] = [
    { weight: 0.3, tier: "mapped", role: "geology", group: "lithology" },
  ];
  const weakNegative = (group = "evidence:s1:confirmed_absent:alteration"): ScoredEvidence =>
    ({ weight: 0.3, tier: "user_reported", role: "field", group, polarity: "negative" });
  const strongNegative = (group = "evidence:s1:confirmed_absent:alteration"): ScoredEvidence =>
    ({ weight: 0.9, tier: "expert_field", role: "field", group, polarity: "negative" });

  test("A. strong positive evidence only — high score, unaffected by the new code path", () => {
    const score = computeIntegratedProspectivity(strongPositive);
    expect(score).toBeGreaterThan(0.9);
  });

  test("B. weak positive evidence only — low score", () => {
    const score = computeIntegratedProspectivity(weakPositive);
    expect(score).toBeLessThan(0.4);
  });

  test("C. strong positive + weak negative — damped, but still clearly encouraging", () => {
    const withoutNeg = computeIntegratedProspectivity(strongPositive);
    const withNeg = computeIntegratedProspectivity([...strongPositive, weakNegative()]);
    expect(withNeg).toBeLessThan(withoutNeg);
    // A weak, single negative finding must not "destroy" a strong target.
    expect(withNeg).toBeGreaterThan(0.6);
  });

  test("D. strong positive + strong negative — score falls substantially", () => {
    const withoutNeg = computeIntegratedProspectivity(strongPositive);
    const withNeg = computeIntegratedProspectivity([...strongPositive, strongNegative()]);
    expect(withNeg).toBeLessThan(withoutNeg * 0.5);
    // But a mapped fault / real observation does not stop existing — the floor
    // is bounded above zero, by construction (1 - NEGATIVE_DAMPING_CEILING > 0).
    expect(withNeg).toBeGreaterThan(0);
  });

  test("E. no evidence at all — score is zero", () => {
    expect(computeIntegratedProspectivity([])).toBe(0);
  });

  test("F. untested/unrecorded indicators produce NOTHING — same score as omitting them entirely", () => {
    // "Not tested" must never silently become "tested negative". Simulated here
    // by simply not including any negative-polarity item — the production
    // enforcement point (confirmedAbsentToObservations' tri-state gate) is
    // covered in structuredEvidenceSource.test.ts.
    const withNothingRecorded = computeIntegratedProspectivity(strongPositive);
    const explicitlyOmitted = computeIntegratedProspectivity([...strongPositive]);
    expect(withNothingRecorded).toBe(explicitlyOmitted);
  });

  test("G. confirmed negative evidence is a real, distinct polarity", () => {
    const item = weakNegative();
    expect(item.polarity).toBe("negative");
    const score = computeIntegratedProspectivity([item]);
    // A negative-only pool with no positive evidence at all still scores 0 —
    // there is nothing FOR it to damp.
    expect(score).toBe(0);
  });

  test("H. duplicate negative evidence in the SAME group collapses — not counted twice", () => {
    const oneNeg = computeIntegratedProspectivity([...strongPositive, weakNegative()]);
    const duplicated = computeIntegratedProspectivity([
      ...strongPositive, weakNegative(), weakNegative(), weakNegative(),
    ]);
    expect(duplicated).toBe(oneNeg);
  });

  test("I. negative evidence of DIFFERENT canonical types does not wrongly collapse", () => {
    const oneType = computeIntegratedProspectivity([
      ...strongPositive, weakNegative("evidence:s1:confirmed_absent:alteration"),
    ]);
    const twoTypes = computeIntegratedProspectivity([
      ...strongPositive,
      weakNegative("evidence:s1:confirmed_absent:alteration"),
      weakNegative("evidence:s1:confirmed_absent:sulfides"),
    ]);
    // Two independently-checked-absent indicators corroborate each other and
    // damp MORE than one alone — they must not collapse into the same group.
    expect(twoTypes).toBeLessThan(oneType);
  });

  test("J. negative evidence never produces a score below 0, however extreme", () => {
    const manyStrongPositive: ScoredEvidence[] = Array.from({ length: 8 }, (_, i) => ({
      weight: 1, tier: "lab_verified", role: "geochemistry", group: `g${i}`,
    }));
    const manyStrongNegative: ScoredEvidence[] = Array.from({ length: 8 }, (_, i) => ({
      weight: 1, tier: "lab_verified", role: "field", group: `n${i}`, polarity: "negative" as const,
    }));
    const score = computeIntegratedProspectivity([...manyStrongPositive, ...manyStrongNegative]);
    expect(score).toBeGreaterThanOrEqual(0);
    // And the floor is bounded above zero — the damping ceiling guarantees this
    // algebraically, not via a clamp.
    expect(score).toBeGreaterThan(0);
    expect(score).toBeCloseTo(1 - NEGATIVE_DAMPING_CEILING, 1);
  });

  test("K. score never exceeds 1, with or without negative evidence present", () => {
    const maxed: ScoredEvidence[] = Array.from({ length: 10 }, (_, i) => ({
      weight: 1, tier: "lab_verified", role: "geochemistry", group: `g${i}`,
    }));
    expect(computeIntegratedProspectivity(maxed)).toBeLessThanOrEqual(1);
    expect(computeIntegratedProspectivity([...maxed, weakNegative()])).toBeLessThanOrEqual(1);
  });

  test("negative items never affect the score when they lose their group to a stronger POSITIVE item — pools stay separate", () => {
    // A positive and a negative item sharing a group key is a genuine
    // contradiction (a form entered "alteration present" AND "no alteration,
    // checked" — a real data-entry conflict) — verifying they do NOT silently
    // cancel each other via the group map, because positive/negative are
    // combined in SEPARATE pools, never merged into one group map together.
    const contradictory: ScoredEvidence[] = [
      { weight: 0.6, tier: "expert_field", role: "field", group: "evidence:s1:alteration" },
      { weight: 0.6, tier: "expert_field", role: "field", group: "evidence:s1:confirmed_absent:alteration", polarity: "negative" },
    ];
    const score = computeIntegratedProspectivity(contradictory);
    // Positive alone would score 0.6*0.75=0.45; if the negative item silently
    // deleted it via a shared group map this would read 0. It must not.
    expect(score).toBeGreaterThan(0);
  });
});

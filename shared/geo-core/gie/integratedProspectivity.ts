// Integrated prospectivity — the SAME noisy-OR arithmetic as computeConfidence(),
// extended to a wider evidence vocabulary that includes user-reported and
// AI-visual sources, without touching the validated engine at all.
//
// WHY A SEPARATE MODULE, NOT AN EDIT TO confidence.ts. `computeConfidence()` is
// the baseline engine — LOO AUC 0.900, byte-identical, and it must stay that way.
// This file extends TIER_WEIGHT the same way shared/geo-core/gie/scoring.ts
// already does for a different scorer (spread, never mutate), and reimplements
// the same small noisy-OR formula against that extended table, rather than
// parameterising confidence.ts's own function. Two call sites, one arithmetic
// rule, zero risk to the validated one.
//
// WHAT THIS IS NOT. Not a probability. Not a replacement for baselineScore or
// reportScore — both are read here, never recomputed. Not a place for a user's
// own claim to earn a verified tier: `lab_verified`/`expert_verified` require an
// explicit, structurally-required flag from the caller (see integratedProspectivity.test.ts
// for the contract), never inferred from "the section was filled in".
import { TIER_WEIGHT } from "../confidence.ts";
import type { ScoredEvidence } from "./prospectivityReport.ts";

/**
 * TIER_WEIGHT, extended for evidence sources the baseline engine has never
 * carried. The five original entries are copied verbatim — a test asserts that.
 *
 *   verified_geophysics  An instrument reading (magnetics/IP/EM/gravity). Objective
 *                        measurement, but no institutional review — below `mapped`
 *                        (0.85, a peer-reviewed survey), above self-report.
 *   expert_field         A structured field description via the new evidence form.
 *                        More rigorous than a tapped waypoint type, still a single
 *                        unverified observer.
 *   remote_sensing       Interpreted, indirect — the SAME epistemic tier as the
 *                        existing `lineaments` role, which this codebase already
 *                        measured to leak 4.3x and withheld from scoring for that
 *                        reason (see evidenceRoles.ts). Defined here, but callers
 *                        must keep it out of any live score until an equivalent
 *                        measurement is done — see ROLES_NOT_SCORED's own history.
 *   user_reported        The default. Any new-form entry that does not earn one of
 *                        the stronger, explicitly-gated tiers above lands here. This
 *                        is the actual enforcement point for "user input never
 *                        silently becomes verified evidence".
 *   ai_visual            Not invented here — the same 0.4 already chosen for AI
 *                        evidence in shared/geo-core/gie/scoring.ts (a different
 *                        scorer). Reused, not re-litigated.
 */
export const INTEGRATED_TIER_WEIGHT: Record<string, number> = {
  ...TIER_WEIGHT,
  verified_geophysics: 0.8,
  expert_field: 0.75,
  remote_sensing: 0.6,
  user_reported: 0.55,
  ai_visual: 0.4,
};

function effectiveWeight(e: ScoredEvidence): number {
  const mult = e.tier ? (INTEGRATED_TIER_WEIGHT[e.tier] ?? 1) : 1;
  return Math.max(0, Math.min(1, e.weight * mult));
}

/**
 * Group-collapse + noisy-OR over one polarity's items — the exact arithmetic
 * `computeConfidence()` uses, extracted so both the positive and the negative
 * pool run through IDENTICAL code (same double-count protection, same
 * strongest-wins-per-group rule, same rounding). This is deliberately the only
 * place either pool is combined.
 */
function combine(scored: readonly ScoredEvidence[]): number {
  const byGroup = new Map<string, ScoredEvidence>();
  for (const e of scored) {
    const cur = byGroup.get(e.group);
    if (!cur || effectiveWeight(e) > effectiveWeight(cur)) byGroup.set(e.group, e);
  }
  if (byGroup.size === 0) return 0;
  let complement = 1;
  for (const e of byGroup.values()) complement *= (1 - effectiveWeight(e));
  return Math.round((1 - complement) * 100) / 100;
}

/**
 * How much a fully-corroborated negative pool can pull the score down.
 *
 * Never 1.0 — a mapped fault or a known nearby occurrence does not stop being
 * real because one field visit found nothing at one exact spot inside a ~5km2
 * cell. Bounding the damping keeps a positive score's floor above zero no
 * matter how much confirmed-absent evidence accumulates, by construction
 * (`finalScore = positiveScore * (1 - CEILING * negativeConfidence)`, and
 * `1 - CEILING > 0`), not by a clamp.
 */
export const NEGATIVE_DAMPING_CEILING = 0.85;

/**
 * The integrated score.
 *
 * NEGATIVE EVIDENCE (Architecture: Integrated Prospectivity Score, Priority 1).
 * `computeConfidence()` (confidence.ts, the validated ranking baseline) is a
 * pure positive accumulator and stays that way — this function alone gained a
 * second, DISCONFIRMING pool, kept structurally separate from the positive one:
 *
 *   positiveScore      = combine() over every item with polarity !== "negative"
 *   negativeConfidence  = combine() over every item with polarity === "negative"
 *   score               = positiveScore * (1 - NEGATIVE_DAMPING_CEILING * negativeConfidence)
 *
 * WITH NO NEGATIVE ITEMS this is `positiveScore * 1` — byte-identical to the
 * noisy-OR this function has always computed, and (per the module's own
 * pre-existing baseline-equivalence test) byte-identical to computeConfidence()
 * on baseline-only input. No transformation happens in the common case; there
 * was nothing to preserve because nothing changed.
 *
 * Positive and negative items are group-collapsed WITHIN their own pool only —
 * a "quartz vein observed" and a "no quartz vein — checked" at the same site
 * are a genuine contradiction, not a cancellation, and both are kept visible
 * (one damps, one still contributes upward) rather than one silently deleting
 * the other.
 *
 * See prospectivityReport.ts's `ScoredEvidence.polarity` doc for the rule on
 * what may ever set `polarity: "negative"` — nothing here enforces it; the
 * enforcement point is upstream, at the ONLY place a negative item is ever
 * constructed (structuredEvidenceSource.ts, gated behind an explicit
 * "specifically checked and absent" field the user must deliberately set).
 */
export function computeIntegratedProspectivity(scored: readonly ScoredEvidence[]): number {
  const positive = scored.filter((e) => e.polarity !== "negative");
  const negative = scored.filter((e) => e.polarity === "negative");

  const positiveScore = combine(positive);
  if (negative.length === 0) return positiveScore;

  const negativeConfidence = combine(negative);
  const damping = 1 - NEGATIVE_DAMPING_CEILING * negativeConfidence;
  return Math.round(positiveScore * damping * 100) / 100;
}

// ── AI visual evidence → a bounded weight, never a probability ──────────────

/** The most a single AI-visual item may ever contribute, before its tier multiplier. */
export const AI_VISUAL_WEIGHT_CEILING = 0.5;

/**
 * How much a visual aspect is WORTH, independent of how clearly it was seen.
 * Mirrors the ordering already used in TYPE_SIGNAL (localEvidence.ts) for tapped
 * waypoint types — a mineral phase or a vein outranks rock colour or texture,
 * because that is the same judgement the app already makes about what a human
 * observer's report is worth, applied to what the model reports seeing.
 */
export const AI_ASPECT_BASE_WEIGHT: Record<string, number> = {
  mineral: 0.6,
  vein: 0.55,
  alteration: 0.5,
  structure: 0.45,
  weathering: 0.35,
  texture: 0.3,
  color: 0.25,
  other: 0.2,
};

/**
 * Convert what the vision stage reported into a bounded evidence weight.
 *
 * `quality = clarity x imageQuality` is the SAME combination already computed at
 * supabase/functions/_shared/gie/vision.ts:94-104 for a different (GIE stage-4)
 * scorer — reused, not reinvented. The result is capped at AI_VISUAL_WEIGHT_CEILING
 * before the aspect multiplier, and the `ai_visual` tier (0.4) is applied on TOP of
 * this by the caller through `computeIntegratedProspectivity` — so a clarity of
 * 1.0 on the strongest aspect tops out at 0.5 x 0.6 x 0.4 = 0.12 effective, nowhere
 * near "0.95 AI confidence" read as 0.95 of the score.
 */
export function aiVisualWeight(clarity: number, imageQuality: number, aspect: string): number {
  const quality = Math.max(0, Math.min(1, clarity)) * Math.max(0, Math.min(1, imageQuality));
  const bounded = Math.min(quality, AI_VISUAL_WEIGHT_CEILING);
  const base = AI_ASPECT_BASE_WEIGHT[aspect] ?? AI_ASPECT_BASE_WEIGHT.other;
  return Math.round(bounded * base * 1000) / 1000;
}

// ── Evidence grouping — double-count prevention ──────────────────────────────

/** Waypoint type -> canonical evidence type, for grouping against AI/lab/mapping evidence. */
const WAYPOINT_CANONICAL: Record<string, string> = {
  "quartz-vein": "quartz_vein",
  vein: "vein",
  sulfides: "sulfides",
  gossan: "gossan",
  alteration: "alteration",
  fault: "fault",
  contact: "contact",
  outcrop: "outcrop",
  float: "float",
  other: "other",
};

/** AI-vision aspect -> canonical evidence type, before keyword refinement. */
const VISUAL_ASPECT_CANONICAL: Record<string, string> = {
  vein: "vein",
  mineral: "mineral_phase",
  alteration: "alteration",
  weathering: "weathering",
  structure: "structure",
  texture: "texture",
  color: "colour",
  other: "other",
};

/**
 * When the AI's own statement names something more specific than its aspect
 * bucket, refine the canonical type so it can collapse with a matching field/lab
 * observation of the SAME thing (a field "quartz vein" and an AI-read "quartz
 * vein" are one fact) while staying apart from a DIFFERENT one (a field "quartz
 * vein" and an AI-read "visible native gold" are two facts, and both must count).
 *
 * Deliberately narrow and literal. An unmatched statement falls through to its
 * aspect bucket rather than being guessed at — under-collapsing is the safe
 * failure direction here (two items counted as independent when they were really
 * one overstates evidence by a bounded amount; the reverse could hide a second,
 * genuinely independent finding).
 */
const KEYWORD_REFINEMENTS: ReadonlyArray<{ aspectIn: string[]; pattern: RegExp; canonical: string }> = [
  { aspectIn: ["mineral"], pattern: /\bgold\b|native metal/i, canonical: "native_metal" },
  { aspectIn: ["mineral"], pattern: /sulfide|sulphide|pyrite|chalcopyrite|galena/i, canonical: "sulfides" },
  { aspectIn: ["vein", "mineral"], pattern: /quartz/i, canonical: "quartz_vein" },
  { aspectIn: ["weathering", "alteration"], pattern: /gossan|iron.?stain/i, canonical: "gossan" },
];

/** Canonical evidence type for a tapped waypoint/form observation type. */
export function canonicalWaypointType(type: string): string {
  return WAYPOINT_CANONICAL[type] ?? "other";
}

/** Canonical evidence type for an AI-visual finding, keyword-refined where possible. */
export function canonicalVisualType(aspect: string, statement?: string): string {
  if (statement) {
    for (const r of KEYWORD_REFINEMENTS) {
      if (r.aspectIn.includes(aspect) && r.pattern.test(statement)) return r.canonical;
    }
  }
  return VISUAL_ASPECT_CANONICAL[aspect] ?? "other";
}

/**
 * The group key every evidence-collapsing function in this module expects.
 *
 * Anchored to a physical site (a waypoint id or a sample id — both already exist
 * and are stable) rather than to spatial proximity. The codebase's existing
 * occurrence-grouping already rejects distance-based merging ("keying on distance
 * would silently merge two records that happen to share it" — targeting.ts) for
 * the same reason: two genuinely independent finds a few metres apart must stay
 * independent. Anchoring to one physical id gives spatial coherence without that
 * risk.
 */
export function evidenceGroupKey(siteAnchorId: string, canonicalType: string): string {
  return `evidence:${siteAnchorId}:${canonicalType}`;
}

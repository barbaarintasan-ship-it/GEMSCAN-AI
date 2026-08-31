// AI-visual observations → ScoredEvidence, for the SERVER "final" Integrated
// Prospectivity Score (Architecture: Integrated Prospectivity Score, Stage 4).
//
// Reuses the SAME math the client uses (shared/geo-core/gie/integratedProspectivity.ts)
// — aiVisualWeight's bounded formula, canonicalVisualType's keyword-refined
// grouping, evidenceGroupKey's site-anchored key — so a field-recorded quartz
// vein and an AI-read quartz vein at the same target cell collapse to ONE
// group here exactly as they already do on the device (structuredEvidenceSource.ts).
//
// This produces evidence for SCORING only. The report's VISUAL EVIDENCE
// section is built separately by visionFindings.ts, on a short leash of its
// own (strength capped moderate, confidence fixed low, never a mineral
// claim) — this file does not replace that, it feeds a different, numeric
// consumer.
import {
  aiVisualWeight, canonicalVisualType, evidenceGroupKey,
} from "../../../../shared/geo-core/gie/integratedProspectivity.ts";
import type { ScoredEvidence } from "../../../../shared/geo-core/gie/prospectivityReport.ts";
import type { VisualObservation } from "./vision.ts";

/**
 * @param obs           what the vision stage read from the mission's photographs
 * @param siteAnchorId  the target cell (EnginePackageSummary.targetCell) — vision
 *                      runs once per mission over a batch of photos with no
 *                      per-photo attribution to a waypoint, so the cell is the
 *                      finest anchor available; the SAME one the client uses
 *                      for structured-evidence grouping (structuredEvidenceSource.ts
 *                      is anchored to `mission.cell`), so the two sides agree.
 * @param imageQuality  0..1, scales every item's weight alongside its own clarity.
 *                      Defaults to 1 — no per-photo quality signal reaches this
 *                      layer today, matching vision.ts's own visualEvidence()
 *                      default for the same reason.
 */
export function aiVisualToScoredEvidence(
  obs: readonly VisualObservation[], siteAnchorId: string, imageQuality = 1,
): ScoredEvidence[] {
  return obs.map((o) => ({
    weight: aiVisualWeight(o.clarity, imageQuality, o.aspect),
    tier: "ai_visual",
    // "field" — the closest existing evidence category to a direct observation
    // of the ground. Not read by computeIntegratedProspectivity() (only
    // weight/tier/group are), so this is bookkeeping only.
    role: "field",
    group: evidenceGroupKey(siteAnchorId, canonicalVisualType(o.aspect, o.statement)),
  }));
}

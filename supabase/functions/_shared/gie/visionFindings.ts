// Vision observations → report evidence, on a SHORT LEASH.
//
// This is the only place a Gemini-vision observation becomes a piece of report
// evidence, and it exists to make three rules impossible to break (Phase 2 reqs):
//
//   · Vision is VISUAL EVIDENCE ONLY. Every item is origin "photograph", tagged
//     source "gemini_vision" and verificationStatus "unverified".
//   · Vision may NOT confirm gold, confirm a deposit, or stand in for assay /
//     geochemistry. So the significance codes are neutral, descriptive facts about
//     the IMAGE (visible veining, possible alteration) — never a mineral claim —
//     strength is capped at MODERATE, and confidence is fixed LOW. A photograph can
//     show a vein clearly; it can never, alone, be strong evidence of ore.
//   · The mapping is deterministic here, not asked of the model, so a prompt cannot
//     be talked into promoting a photo to proof.
import type { FindingEvidence } from "../../../../shared/geo-core/gie/missionFindings.ts";
import type { VisualObservation, VisualAspect } from "./vision.ts";

/**
 * What each visual aspect MEANS, as a neutral code. Deliberately about the image,
 * not the geology's economic value — none of these asserts mineralisation.
 */
const ASPECT_SIGNIFICANCE: Record<VisualAspect, string> = {
  vein: "visible_veining",
  mineral: "visible_mineral_phase",
  alteration: "possible_alteration",
  weathering: "surface_weathering",
  structure: "visible_structure",
  texture: "rock_texture",
  color: "rock_colour",
  other: "visual_note",
};

/**
 * Convert vision observations into photograph-origin evidence.
 *
 * @param obs      what the vision stage read from the images
 * @param clarityStrongAt  clarity at/above which a finding is "moderate" (else "weak").
 *                 Capped at moderate on purpose — there is no path to "strong" here.
 */
export function visualObservationsToEvidence(
  obs: VisualObservation[],
  clarityStrongAt = 0.66,
): FindingEvidence[] {
  return obs.map((o) => ({
    type: `visual_${o.aspect}`,
    origin: "photograph",
    status: "present",
    // Clarity decides weak vs moderate. Never "strong": a clear photo of a vein is
    // still just a photo of a vein.
    strength: o.clarity >= clarityStrongAt ? "moderate" : "weak",
    // Fixed LOW. Visual evidence is unverified by construction, so it can never lift
    // the report's confidence ceiling toward a mineral claim (see cappedConfidence).
    confidence: "low",
    significance: ASPECT_SIGNIFICANCE[o.aspect] ?? "visual_note",
    source: "gemini_vision",
    verificationStatus: "unverified",
  }));
}

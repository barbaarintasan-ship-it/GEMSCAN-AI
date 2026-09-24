// Team structured evidence (0128) → ScoredEvidence, for the SERVER Integrated
// Prospectivity Score (Phase 8, Solo→Team shared-targeting).
//
// ARCHITECTURE INVARIANT THIS FILE RESPECTS (see mobile/lib/exploration/
// localEvidence.ts's own header note on combineLocalEvidenceSources):
// structured/form evidence must NEVER be fed to TargetingEngine's `local`
// constructor param — that feeds prospectivityEvidence() directly, the
// VALIDATED baseline (LOO AUC 0.900), which must stay byte-identical
// regardless of what any form contains. mission_assignment.prospectivity_score
// (Phase 3) is therefore computed with NO local evidence at all, exactly like
// Solo's baseline. This file instead produces evidence for a SEPARATE,
// informational number — mission_assignment.integrated_score — the same way
// Solo's own structuredEvidenceSource.ts feeds computeClientIntegratedScore()
// and NOT the ranking engine.
//
// Reuses the SAME math both sides already share: computeIntegratedProspectivity's
// noisy-OR, evidenceGroupKey's site-anchored grouping, canonicalWaypointType's
// vocabulary, and assayGrade.ts's exploration-geochemistry grade bands — so a
// Team assay of "3.2 g/t Au" is worth exactly what a Solo assay of the same
// reading is worth, not a re-derived number.
import {
  canonicalWaypointType, computeIntegratedProspectivity, evidenceGroupKey,
} from "../../../../shared/geo-core/gie/integratedProspectivity.ts";
import type { ScoredEvidence } from "../../../../shared/geo-core/gie/prospectivityReport.ts";
import type { Scored } from "../../../../shared/geo-core/gie/prospectivityEvidence.ts";
import { classifyGrade, GRADE_BAND_FACTOR } from "../../../../mobile/lib/geo/assayGrade.ts";

// Same base weights as structuredEvidenceSource.ts (mobile) — copied, not
// re-derived, so a Team submission and a Solo submission of the same finding
// are worth the same before their tier is applied.
const ASSAY_WEIGHT = 0.6;
const GEOPHYSICS_ANOMALY_WEIGHT = 0.55;
const LITHOLOGY_REPORTED_WEIGHT = 0.2;
const VISIBLE_MINERAL_GENERIC_WEIGHT = 0.5;
const HISTORICAL_WORKINGS_WEIGHT = 0.75;
const INDICATOR_WEIGHT: Record<string, number> = {
  gossan: 0.8,
  sulfides: 0.85,
  quartz_vein: 0.7,
  shear_zone: 0.5,
};

// Phase 10.3 (Geological Intelligence Transformation) — negative/disconfirming
// evidence, mirroring mobile/lib/exploration/structuredEvidenceSource.ts's
// NEGATIVE_INDICATOR_WEIGHT/CONFIRMED_ABSENT_LABEL exactly (same values,
// copied not cross-imported — see this file's header note on why Team never
// imports mobile's scoring tables). A Team "confirmed absent" finding is
// worth the same as a Solo one of the same kind.
const NEGATIVE_INDICATOR_WEIGHT: Record<string, number> = {
  alteration: 0.6,
  sulfides: 0.7,
  quartz_vein: 0.55,
  visible_mineralization: 0.6,
  favorable_structure: 0.5,
  geochemical_anomaly: 0.65,
};

const CONFIRMED_ABSENT_TYPE: Record<string, string> = {
  alteration: "alteration",
  sulfides: "sulfides",
  quartzVein: "quartz_vein",
  visibleMineralization: "visible_mineralization",
  favorableStructure: "favorable_structure",
  geochemicalAnomaly: "geochemical_anomaly",
};

/**
 * `payload.confirmedAbsent` (a `ConfirmedAbsentFindings`-shaped record) into
 * negative `ScoredEvidence`. Tri-state by omission, same rule as Solo's
 * `confirmedAbsentToObservations`: only an explicit `true` produces an item —
 * `undefined`/`false` means "not asked", never "confirmed present".
 */
function confirmedAbsentToScored(sampleId: string, tier: string, confirmedAbsent: unknown): ScoredEvidence[] {
  if (!confirmedAbsent || typeof confirmedAbsent !== "object") return [];
  const findings = confirmedAbsent as Record<string, unknown>;
  const out: ScoredEvidence[] = [];
  for (const [key, canonicalType] of Object.entries(CONFIRMED_ABSENT_TYPE)) {
    if (findings[key] !== true) continue;
    out.push({
      weight: NEGATIVE_INDICATOR_WEIGHT[canonicalType], tier, role: "field", polarity: "negative",
      group: evidenceGroupKey(sampleId, `confirmed_absent:${canonicalType}`),
    });
  }
  return out;
}

// remote_sensing is captured (so it's visible in the mission's evidence) but
// not yet admitted to any live score — the SAME withholding Solo's own
// INTEGRATED_ROLES_PENDING_ADMISSION applies, for the same measured reason
// (interpreted/indirect evidence, not yet validated — see evidenceRoles.ts).
const ROLES_PENDING_ADMISSION = ["remote_sensing"];

export interface TeamStructuredEvidenceRow {
  sampleId: string;
  evidenceType: "assay" | "geophysics" | "mapping" | "remote_sensing" | "field_observation";
  payload: Record<string, unknown>;
  /**
   * Already gated server-side at write time (0128/0129's submit_sample /
   * add_sample_structured_evidence: lab_verified requires an explicit
   * lab_accredited=true, else downgraded to expert_verified) — these three
   * values map 1:1 onto INTEGRATED_TIER_WEIGHT's keys, so no re-gating
   * happens here.
   */
  verificationStatus: "user_reported" | "expert_verified" | "lab_verified";
}

function bool(v: unknown): boolean {
  return v === true;
}
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** One structured-evidence row → zero or more scoreable items. */
export function structuredEvidenceRowToScored(row: TeamStructuredEvidenceRow): ScoredEvidence[] {
  const tier = row.verificationStatus;
  const p = row.payload ?? {};
  const out: ScoredEvidence[] = [];

  switch (row.evidenceType) {
    case "assay": {
      const element = str(p.element);
      const result = Number(p.result);
      const unit = str(p.unit);
      if (!element || !Number.isFinite(result)) break;
      const band = classifyGrade(element, result, unit);
      const weight = Math.min(1, ASSAY_WEIGHT * GRADE_BAND_FACTOR[band]);
      out.push({
        weight, tier, role: "geochemistry",
        group: evidenceGroupKey(row.sampleId, `assay:${element.toLowerCase()}`),
      });
      break;
    }
    case "geophysics": {
      if (!bool(p.anomalyPresent)) break; // "geophysics exists" is not evidence — only a reported anomaly is
      const surveyType = str(p.surveyType) || "geophysics";
      out.push({
        weight: GEOPHYSICS_ANOMALY_WEIGHT, tier, role: "geophysics",
        group: evidenceGroupKey(row.sampleId, `geophysics:${surveyType}`),
      });
      break;
    }
    case "mapping": {
      const hostLithology = str(p.hostLithology);
      const veinType = str(p.veinType);
      if (hostLithology) {
        out.push({
          weight: LITHOLOGY_REPORTED_WEIGHT, tier, role: "geology",
          group: evidenceGroupKey(row.sampleId, "lithology_reported"),
        });
      }
      if (bool(p.gossan)) {
        out.push({
          weight: INDICATOR_WEIGHT.gossan, tier, role: "field",
          group: evidenceGroupKey(row.sampleId, canonicalWaypointType("gossan")),
        });
      }
      if (bool(p.sulfides)) {
        out.push({
          weight: INDICATOR_WEIGHT.sulfides, tier, role: "field",
          group: evidenceGroupKey(row.sampleId, canonicalWaypointType("sulfides")),
        });
      }
      if (/quartz/i.test(veinType)) {
        out.push({
          weight: INDICATOR_WEIGHT.quartz_vein, tier, role: "field",
          group: evidenceGroupKey(row.sampleId, canonicalWaypointType("quartz-vein")),
        });
      }
      break;
    }
    case "remote_sensing": {
      const interpretation = str(p.interpretation);
      if (!interpretation) break;
      const source = str(p.source) || "remote_sensing";
      out.push({
        weight: 0.5, tier, role: "remote_sensing",
        group: evidenceGroupKey(row.sampleId, `remote_sensing:${source}`),
      });
      break;
    }
    case "field_observation": {
      if (bool(p.quartzVein)) {
        out.push({
          weight: INDICATOR_WEIGHT.quartz_vein, tier, role: "field",
          group: evidenceGroupKey(row.sampleId, canonicalWaypointType("quartz-vein")),
        });
      }
      if (bool(p.gossanRust)) {
        out.push({
          weight: INDICATOR_WEIGHT.gossan, tier, role: "field",
          group: evidenceGroupKey(row.sampleId, canonicalWaypointType("gossan")),
        });
      }
      if (bool(p.sulfides)) {
        out.push({
          weight: INDICATOR_WEIGHT.sulfides, tier, role: "field",
          group: evidenceGroupKey(row.sampleId, canonicalWaypointType("sulfides")),
        });
      }
      if (bool(p.shearing)) {
        out.push({
          weight: INDICATOR_WEIGHT.shear_zone, tier, role: "field",
          group: evidenceGroupKey(row.sampleId, "shear_zone"),
        });
      }
      if (bool(p.visibleMineral) && !bool(p.quartzVein) && !bool(p.sulfides)) {
        out.push({
          weight: VISIBLE_MINERAL_GENERIC_WEIGHT, tier, role: "field",
          group: evidenceGroupKey(row.sampleId, "visible_mineral_generic"),
        });
      }
      if (bool(p.oldWorkings)) {
        out.push({
          weight: HISTORICAL_WORKINGS_WEIGHT, tier, role: "field",
          group: evidenceGroupKey(row.sampleId, "historical_workings"),
        });
      }
      out.push(...confirmedAbsentToScored(row.sampleId, tier, p.confirmedAbsent));
      break;
    }
  }
  return out;
}

/**
 * The integrated score for one cell: the engine's OWN baseline evidence
 * (`ExplorationTarget.evidence`, already computed by `targetAt()` — never
 * recomputed here) plus every contributor's structured evidence for that
 * cell, combined through the SAME noisy-OR arithmetic Solo's client-side
 * "so-far" integrated score uses. Returns null when there is no structured
 * evidence yet — an unscored cell shows no integrated number rather than a
 * value indistinguishable from "evidence confirmed nothing new".
 */
export function teamIntegratedScore(
  baseline: readonly Scored[],
  rows: readonly TeamStructuredEvidenceRow[],
): number | null {
  if (rows.length === 0) return null;
  const baselineScored: ScoredEvidence[] = baseline.map((s) => ({
    weight: s.item.weight, tier: s.item.tier, role: s.role, group: s.group,
  }));
  const evidenceScored = rows
    .flatMap(structuredEvidenceRowToScored)
    .filter((e) => !ROLES_PENDING_ADMISSION.includes(e.role));
  if (evidenceScored.length === 0) return null;
  return computeIntegratedProspectivity([...baselineScored, ...evidenceScored]);
}

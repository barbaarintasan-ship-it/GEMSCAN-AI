// Converts a StructuredGeologicalEvidence record into Observations the targeting
// engine can score, and computes the client-side "so-far" integrated score.
//
// THE ONE RULE THIS FILE ENFORCES: a VerificationStatus the USER chose is never
// trusted at face value for the strongest tier. `lab_verified` on an assay is
// downgraded to `expert_verified` unless `labAccredited` is explicitly true — a
// distinct flag the form structurally requires, never inferred from "the section
// was filled in". Every conversion function below routes through `gatedTier()`
// for exactly this reason; nothing here calls INTEGRATED_TIER_WEIGHT's tier
// names directly from user input.
//
// WHAT THIS DOES NOT DO. It does not assert an economic cut-off grade — no
// number here claims "this is a mine". Where a result CAN be read against a
// published exploration-geochemistry convention (assayGrade.ts — gold and tin
// only, in their own units, never fitted to this pack's data), the assay's
// weight is scaled by that reading (Priority 2). Everywhere else — any other
// element, any unmatched unit, a missing/invalid/negative number — the result
// stays "unclassified" and the weight stays exactly as flat as it always was.
// Every item's TIER still scales how much a report is worth; the GRADE now
// also scales how much the number itself is worth, honestly bounded.
import type { Observation, LocalEvidenceSource } from "./localEvidence";
import {
  evidenceGroupKey, canonicalWaypointType, computeIntegratedProspectivity,
} from "../../../shared/geo-core/gie/integratedProspectivity";
import type { ScoredEvidence } from "../../../shared/geo-core/gie/prospectivityReport";
import type { Scored } from "../geo/targeting";
import { classifyGrade, GRADE_BAND_FACTOR } from "../geo/assayGrade";
import type {
  StructuredGeologicalEvidence, AssayEntry, GeophysicsEntry, MappingEntry,
  RemoteSensingEntry, FieldObservationEntry, VerificationStatus, ConfirmedAbsentFindings,
} from "../field/structuredEvidenceTypes";

/**
 * Roles that exist and are captured, but are not yet trusted enough to move the
 * score — the same status `contacts`/`drainage`/`lineaments` hold in the
 * baseline engine's `ROLES_NOT_SCORED` (evidenceRoles.ts), for the same reason:
 * `remote_sensing` is interpreted, indirect evidence, measured elsewhere in this
 * codebase (the DEM-lineament leakage test) to need validation before it is
 * allowed to score. `computeClientIntegratedScore`/the server "final" stage both
 * filter this out before calling `computeIntegratedProspectivity` — Stage 6
 * removes the filter once real submissions exist to measure against.
 */
export const INTEGRATED_ROLES_PENDING_ADMISSION: readonly string[] = ["remote_sensing"];

// ── Tier gating ───────────────────────────────────────────────────────────

/**
 * The ONE place a user's own VerificationStatus claim is translated into a real
 * scoring tier. `lab_verified` requires `labAccredited: true`; nothing else can
 * reach it. `expert_verified` is passed through as claimed — a future account-
 * level credential check belongs here too, once that exists, without touching
 * any caller.
 */
function gatedTier(claimed: VerificationStatus, labAccredited: boolean): string {
  if (claimed === "lab_verified") return labAccredited ? "lab_verified" : "expert_verified";
  if (claimed === "expert_verified") return "expert_verified";
  return "user_reported";
}

/** Same gate, for sections with no accreditation concept at all (mapping/RS/field). */
function gatedTierNoLab(claimed: VerificationStatus): string {
  return claimed === "lab_verified" ? "expert_verified" : gatedTier(claimed, false);
}

/**
 * Geophysics has its own dedicated tier (`verified_geophysics`, 0.8): an
 * instrument reading that has actually been reviewed (expert_verified OR
 * lab_verified claimed — geophysics has no "lab" concept, so both collapse to
 * the same verified state) is worth more than a bare self-report, but still
 * below `mapped` (0.85, a peer-reviewed published survey).
 */
function gatedTierGeophysics(claimed: VerificationStatus): string {
  return claimed === "user_reported" ? "user_reported" : "verified_geophysics";
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

// ── Base weights ──────────────────────────────────────────────────────────
//
// Flat per-kind weights, not grade-interpreted — see file header. Indicator
// weights are copied from TYPE_SIGNAL (localEvidence.ts) where the concept
// already exists there (gossan, sulfides, quartz vein, alteration, fault), so a
// form checkbox and a tapped waypoint of the same thing are worth the same
// before their tier is applied — only the TIER should differ (mapped vs
// expert_field vs ai_visual), never the base indicator strength.
const ASSAY_WEIGHT = 0.6;
const GEOPHYSICS_ANOMALY_WEIGHT = 0.55;
const LITHOLOGY_REPORTED_WEIGHT = 0.2;
const STRUCTURAL_MAPPING_WEIGHT = 0.5;
const MINERALIZATION_NOTE_WEIGHT = 0.4;
const REMOTE_SENSING_WEIGHT = 0.5;
const HISTORICAL_WORKINGS_WEIGHT = 0.75;
const VISIBLE_MINERAL_GENERIC_WEIGHT = 0.5;

const INDICATOR_WEIGHT: Record<string, number> = {
  gossan: 0.8,
  sulfides: 0.85,
  quartz_vein: 0.7,
  alteration: 0.6,
  shear_zone: 0.5,
  fault: 0.5,
  breccia: 0.4,
};

function indicatorObservation(
  siteId: string, canonicalType: string, tier: string, statement: string, capturedAt: number,
): Observation | null {
  const weight = INDICATOR_WEIGHT[canonicalType];
  if (weight == null) return null;
  return {
    id: nextId(`ind-${canonicalType}`), type: "other", lat: 0, lng: 0, distanceM: 0,
    weight, statement, notes: "", capturedAt,
    role: "field", tier, group: evidenceGroupKey(siteId, canonicalType),
  };
}

// ── Negative / disconfirming evidence (Priority 1) ───────────────────────
//
// The ONLY producer of `polarity: "negative"` items in the whole system. Every
// weight here is comparable in magnitude to the matching positive indicator
// (a deliberate, checked-absent finding is worth roughly as much attention as
// its positive counterpart would have been) — never invented independently.
const NEGATIVE_INDICATOR_WEIGHT: Record<string, number> = {
  alteration: 0.6,
  sulfides: 0.7,
  quartz_vein: 0.55,
  visible_mineralization: 0.6,
  favorable_structure: 0.5,
  geochemical_anomaly: 0.65,
};

const CONFIRMED_ABSENT_LABEL: Record<keyof ConfirmedAbsentFindings, { type: string; statement: string }> = {
  alteration: { type: "alteration", statement: "Alteration specifically checked and absent" },
  sulfides: { type: "sulfides", statement: "Sulfides specifically checked and absent" },
  quartzVein: { type: "quartz_vein", statement: "Quartz veining specifically checked and absent" },
  visibleMineralization: {
    type: "visible_mineralization", statement: "Visible mineralization specifically checked and absent",
  },
  favorableStructure: {
    type: "favorable_structure", statement: "No fault, shear zone or favourable structure observed nearby",
  },
  geochemicalAnomaly: {
    type: "geochemical_anomaly", statement: "Geochemical anomaly specifically tested for and absent",
  },
};

/**
 * A `ConfirmedAbsentFindings` record into negative `Observation`s.
 *
 * Every field is a tri-state by omission (see the type's own doc): only an
 * explicit `true` produces an item. `undefined`/`false` from a field the user
 * never touched produces NOTHING — "not mentioned" must never become
 * "confirmed absent" by silently defaulting a boolean.
 */
export function confirmedAbsentToObservations(
  siteId: string, findings: ConfirmedAbsentFindings | undefined, tier: string, now: number,
): Observation[] {
  if (!findings) return [];
  const out: Observation[] = [];
  for (const key of Object.keys(CONFIRMED_ABSENT_LABEL) as Array<keyof ConfirmedAbsentFindings>) {
    if (findings[key] !== true) continue; // tri-state: only an explicit true counts
    const { type, statement } = CONFIRMED_ABSENT_LABEL[key];
    const weight = NEGATIVE_INDICATOR_WEIGHT[type];
    out.push({
      id: nextId(`neg-${type}`), type: "other", lat: 0, lng: 0, distanceM: 0,
      weight, statement, notes: "", capturedAt: now,
      role: "field", tier, polarity: "negative",
      group: evidenceGroupKey(siteId, `confirmed_absent:${type}`),
    });
  }
  return out;
}

// ── A. Laboratory / assay ────────────────────────────────────────────────

export function assaysToObservations(
  siteId: string, entries: readonly AssayEntry[], now: number,
): Observation[] {
  const out: Observation[] = [];
  for (const a of entries) {
    if (a.result == null || !a.element.trim()) continue; // nothing reported yet
    const tier = gatedTier(a.verificationStatus, a.labAccredited);
    const canonicalType = `assay:${a.element.trim().toLowerCase()}`;
    // Priority 2 — grade-aware weighting. "unclassified" (any element/unit
    // this pack has no published convention for, or an invalid/negative
    // number) leaves the factor at 1.0 — byte-identical to the flat weight
    // this always was.
    const band = classifyGrade(a.element, a.result, a.unit);
    const weight = Math.min(1, ASSAY_WEIGHT * GRADE_BAND_FACTOR[band]);
    out.push({
      id: nextId("assay"), type: "other", lat: a.location?.lat ?? 0, lng: a.location?.lng ?? 0,
      distanceM: 0, weight,
      statement: `${a.element.trim()} assay: ${a.result} ${a.unit}` +
        (band !== "unclassified" ? ` (${band})` : ""),
      notes: a.notes, capturedAt: now,
      role: "geochemistry", tier, group: evidenceGroupKey(siteId, canonicalType),
    });
  }
  return out;
}

// ── B. Ground geophysics ─────────────────────────────────────────────────

export function geophysicsToObservations(
  siteId: string, entries: readonly GeophysicsEntry[], now: number,
): Observation[] {
  const out: Observation[] = [];
  for (const g of entries) {
    // "Geophysics exists" is not evidence. Only a reported anomaly is.
    if (!g.anomalyPresent) continue;
    const tier = gatedTierGeophysics(g.verificationStatus);
    const canonicalType = `geophysics:${g.surveyType}`;
    out.push({
      id: nextId("geophysics"), type: "other", lat: g.location?.lat ?? 0, lng: g.location?.lng ?? 0,
      distanceM: 0, weight: GEOPHYSICS_ANOMALY_WEIGHT,
      statement: `${g.surveyType} anomaly: ${g.anomalyDescription || "reported"}`,
      notes: g.notes, capturedAt: now,
      role: "geophysics", tier, group: evidenceGroupKey(siteId, canonicalType),
    });
  }
  return out;
}

// ── C. Detailed geological mapping ───────────────────────────────────────

export function mappingToObservations(
  siteId: string, entries: readonly MappingEntry[], now: number,
): Observation[] {
  const out: Observation[] = [];
  for (const m of entries) {
    const tier = gatedTierNoLab(m.mappingConfidence);

    if (m.hostLithology.trim() || m.rockType.trim() || m.formationUnit.trim()) {
      out.push({
        id: nextId("lithology"), type: "other", lat: 0, lng: 0, distanceM: 0,
        weight: LITHOLOGY_REPORTED_WEIGHT,
        statement: [m.hostLithology, m.rockType, m.formationUnit].filter(Boolean).join(" / "),
        notes: m.notes, capturedAt: now,
        role: "geology", tier, group: evidenceGroupKey(siteId, "lithology_reported"),
      });
    }

    const hasStructural = m.fault || m.shearZone || m.fold || m.breccia ||
      m.veinOrientation.trim() !== "" || m.strikeDeg != null || m.dipDeg != null;
    if (hasStructural) {
      out.push({
        id: nextId("structural-mapping"), type: "other", lat: 0, lng: 0, distanceM: 0,
        weight: STRUCTURAL_MAPPING_WEIGHT,
        statement: `Structural mapping: ${
          [m.fault && "fault", m.shearZone && "shear zone", m.fold && "fold", m.breccia && "breccia"]
            .filter(Boolean).join(", ") || "orientation recorded"
        }`,
        notes: m.notes, capturedAt: now,
        role: "structural", tier, group: evidenceGroupKey(siteId, "structural_mapping"),
      });
    }

    if (m.gossan) {
      const o = indicatorObservation(siteId, canonicalWaypointType("gossan"), tier, "Gossan mapped", now);
      if (o) out.push(o);
    }
    if (m.sulfides) {
      const o = indicatorObservation(siteId, canonicalWaypointType("sulfides"), tier, "Sulfides mapped", now);
      if (o) out.push(o);
    }
    if (/quartz/i.test(m.veinType)) {
      const o = indicatorObservation(
        siteId, canonicalWaypointType("quartz-vein"), tier, `Vein mapped: ${m.veinType}`, now,
      );
      if (o) out.push(o);
    } else if (m.veinType.trim()) {
      out.push({
        id: nextId("vein"), type: "other", lat: 0, lng: 0, distanceM: 0,
        weight: INDICATOR_WEIGHT.quartz_vein * 0.7, // a non-quartz vein type, weaker default
        statement: `Vein mapped: ${m.veinType}`, notes: m.notes, capturedAt: now,
        role: "field", tier, group: evidenceGroupKey(siteId, "vein_other"),
      });
    }
    if (m.alteration.trim()) {
      const o = indicatorObservation(
        siteId, canonicalWaypointType("alteration"), tier, `Alteration: ${m.alteration}`, now,
      );
      if (o) out.push(o);
    }

    if (m.visibleMineralization.trim() || m.mineralAssemblage.trim()) {
      out.push({
        id: nextId("mineralization-note"), type: "other", lat: 0, lng: 0, distanceM: 0,
        weight: MINERALIZATION_NOTE_WEIGHT,
        statement: [m.visibleMineralization, m.mineralAssemblage].filter(Boolean).join(" / "),
        notes: m.notes, capturedAt: now,
        role: "field", tier, group: evidenceGroupKey(siteId, "mineralization_note"),
      });
    }
  }
  return out;
}

// ── D. Remote sensing ─────────────────────────────────────────────────────
//
// Produced here so it is CAPTURED and VISIBLE in the evidence coverage panel —
// but callers must filter role === "remote_sensing" out before scoring (see
// INTEGRATED_ROLES_PENDING_ADMISSION). Never given the "fault"/"structural"
// canonical type, however the interpretation reads: an interpreted lineament is
// not a mapped fault (Architecture invariant, restated for this form).

export function remoteSensingToObservations(
  siteId: string, entries: readonly RemoteSensingEntry[], now: number,
): Observation[] {
  const out: Observation[] = [];
  for (const r of entries) {
    const hasContent = r.interpretation.trim() || r.alterationAnomaly.trim() ||
      r.spectralAnomaly.trim() || r.structuralAnomaly.trim() || r.lineamentInterpretation.trim();
    if (!hasContent) continue;
    const canonicalType = `remote_sensing:${r.source}`;
    out.push({
      id: nextId("remote-sensing"), type: "other", lat: 0, lng: 0, distanceM: 0,
      weight: REMOTE_SENSING_WEIGHT,
      statement: `${r.source} interpretation: ${r.interpretation || r.structuralAnomaly ||
        r.alterationAnomaly || r.spectralAnomaly || r.lineamentInterpretation}`,
      notes: r.notes, capturedAt: now,
      role: "remote_sensing", tier: "remote_sensing", group: evidenceGroupKey(siteId, canonicalType),
    });
  }
  return out;
}

// ── E. Expert / field observation ────────────────────────────────────────

export function fieldObservationsToObservations(
  siteId: string, entries: readonly FieldObservationEntry[], now: number,
): Observation[] {
  const out: Observation[] = [];
  for (const f of entries) {
    const tier = gatedTierNoLab(f.confidence);

    if (f.quartzVein) {
      const o = indicatorObservation(
        siteId, canonicalWaypointType("quartz-vein"), tier, "Quartz vein observed", now,
      );
      if (o) out.push(o);
    }
    if (f.gossanRust) {
      const o = indicatorObservation(
        siteId, canonicalWaypointType("gossan"), tier, "Gossan / iron oxide observed", now,
      );
      if (o) out.push(o);
    }
    if (f.sulfides) {
      const o = indicatorObservation(
        siteId, canonicalWaypointType("sulfides"), tier, "Sulfides observed", now,
      );
      if (o) out.push(o);
    }
    if (f.alteration) {
      const o = indicatorObservation(
        siteId, canonicalWaypointType("alteration"), tier, "Alteration observed", now,
      );
      if (o) out.push(o);
    }
    if (f.shearing) {
      // No matching waypoint type — "shear_zone" is a canonical type of its own.
      const o = indicatorObservation(siteId, "shear_zone", tier, "Shearing observed", now);
      if (o) out.push(o);
    }
    if (f.faultExposure) {
      const o = indicatorObservation(
        siteId, canonicalWaypointType("fault"), tier, "Fault exposure observed", now,
      );
      if (o) out.push(o);
    }
    if (f.visibleMineral && !f.quartzVein && !f.sulfides) {
      out.push({
        id: nextId("visible-mineral"), type: "other", lat: 0, lng: 0, distanceM: 0,
        weight: VISIBLE_MINERAL_GENERIC_WEIGHT, statement: "Visible mineral observed",
        notes: f.notes, capturedAt: now,
        role: "field", tier, group: evidenceGroupKey(siteId, "visible_mineral_generic"),
      });
    }

    const workings = f.oldWorkings || f.activeArtisanalMining || f.pits || f.shafts ||
      f.adits || f.tailings || f.historicalProduction || f.localMiningEvidence;
    if (workings) {
      out.push({
        id: nextId("historical-workings"), type: "other", lat: 0, lng: 0, distanceM: 0,
        weight: HISTORICAL_WORKINGS_WEIGHT,
        statement: `Historical/active mining evidence: ${
          [
            f.oldWorkings && "old workings", f.activeArtisanalMining && "active artisanal mining",
            f.pits && "pits", f.shafts && "shafts", f.adits && "adits", f.tailings && "tailings",
            f.historicalProduction && "historical production", f.localMiningEvidence && "local mining evidence",
          ].filter(Boolean).join(", ")
        }`,
        notes: f.notes, capturedAt: now,
        role: "field", tier, group: evidenceGroupKey(siteId, "historical_workings"),
      });
    }

    if (f.otherObservations.trim() || f.expertInterpretation.trim()) {
      out.push({
        id: nextId("field-note"), type: "other", lat: 0, lng: 0, distanceM: 0,
        weight: MINERALIZATION_NOTE_WEIGHT,
        statement: [f.otherObservations, f.expertInterpretation].filter(Boolean).join(" / "),
        notes: f.notes, capturedAt: now,
        role: "field", tier, group: evidenceGroupKey(siteId, "field_note"),
      });
    }

    out.push(...confirmedAbsentToObservations(siteId, f.confirmedAbsent, tier, now));
  }
  return out;
}

// ── Top level ─────────────────────────────────────────────────────────────

/** Every Observation this evidence record currently produces, across all five sections. */
export function structuredEvidenceToObservations(
  e: StructuredGeologicalEvidence, now: number,
): Observation[] {
  return [
    ...assaysToObservations(e.siteId, e.assays, now),
    ...geophysicsToObservations(e.siteId, e.geophysics, now),
    ...mappingToObservations(e.siteId, e.mapping, now),
    ...remoteSensingToObservations(e.siteId, e.remoteSensing, now),
    ...fieldObservationsToObservations(e.siteId, e.fieldObservations, now),
  ];
}

/** A `LocalEvidenceSource` a `combineLocalEvidenceSources()` call can compose with. */
export function makeStructuredEvidenceSource(
  e: StructuredGeologicalEvidence, now: () => number = Date.now,
): LocalEvidenceSource {
  return {
    observationsNear: () => structuredEvidenceToObservations(e, now()),
  };
}

// ── Client "so-far" integrated score ─────────────────────────────────────

/**
 * baseline (already-scored Scored[] from prospectivityEvidence()) + this
 * evidence record, as the flat `{weight,tier,role,group}` list
 * `computeIntegratedProspectivity()` consumes.
 *
 * Exposed separately from the score itself (below) because the SERVER "final"
 * stage (Stage 4) needs this exact list, not just the number it produces — it
 * folds AI-visual evidence into the SAME combined set before scoring, so a
 * field-recorded quartz vein and an AI-read quartz vein in the same photo
 * collapse to one group there too, not just on the device. The package carries
 * this list (evidencePackage.ts's `integratedEvidenceItems`) precisely so the
 * server never has to re-derive it from the raw observations.
 *
 * `remote_sensing` items are produced by `structuredEvidenceToObservations`
 * (so the evidence coverage panel can show them as "data present — not
 * scored", exactly like drainage/contacts/lineaments do today) but excluded
 * here before scoring — see INTEGRATED_ROLES_PENDING_ADMISSION.
 */
export function combinedIntegratedEvidence(
  baseline: readonly Scored[], evidence: StructuredGeologicalEvidence, now: number,
): ScoredEvidence[] {
  const baselineScored: ScoredEvidence[] = baseline.map((s) => ({
    weight: s.item.weight, tier: s.item.tier, role: s.role, group: s.group,
  }));
  const newObservations = structuredEvidenceToObservations(evidence, now)
    .filter((o) => !INTEGRATED_ROLES_PENDING_ADMISSION.includes(o.role ?? ""));
  const newScored: ScoredEvidence[] = newObservations.map((o) => ({
    weight: o.weight, tier: o.tier, role: o.role ?? "field", group: o.group ?? `field:${o.id}`,
    polarity: o.polarity,
  }));
  return [...baselineScored, ...newScored];
}

/**
 * baseline + this evidence record → the client-side "so-far" integrated
 * score. AI-visual evidence does not exist yet at this point (Stage 4/the
 * server "final" stage adds it) — this is honest about that, it does not
 * simulate or estimate a placeholder for it.
 */
export function computeClientIntegratedScore(
  baseline: readonly Scored[], evidence: StructuredGeologicalEvidence, now: number,
): number {
  return computeIntegratedProspectivity(combinedIntegratedEvidence(baseline, evidence, now));
}

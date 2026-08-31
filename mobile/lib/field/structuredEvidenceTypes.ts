// User Geological Evidence — a structured record of what a geologist already
// knows, entered as a form rather than a document. Five optional sections
// (Architecture: Integrated Prospectivity Score, Phase 2).
//
// NO SECTION IS REQUIRED, and no field forces a PDF or certificate — the whole
// point is to capture what someone actually has, not what a lab produced. What
// keeps this honest is `VerificationStatus`: entering a number here NEVER, by
// itself, makes it laboratory-verified. `lab_verified`/`expert_verified` require
// an explicit flag from the caller (`labAccredited`/an account credential),
// never inferred from "the section was filled in" — see
// structuredEvidenceSource.ts, which is the ONLY place these records become
// scored evidence, and enforces exactly that rule.
//
// COMMODITY-INDEPENDENT AT ENTRY. `commodity` is recorded on the record for
// context and for the report, but nothing here reads it to decide how to
// convert a section into evidence — that conditioning happens later, at scoring
// time, through the existing commodityModel.ts factorFor()/isRelevant() gates,
// the same mechanism structural/terrain/drainage already use.

/** How much this specific piece of evidence can be trusted, stated by the source. */
export type VerificationStatus = "user_reported" | "expert_verified" | "lab_verified";

export const VERIFICATION_STATUSES: readonly VerificationStatus[] =
  ["user_reported", "expert_verified", "lab_verified"];

export type AssayUnit = "g/t" | "ppm" | "%" | "mg/kg" | "other";
export const ASSAY_UNITS: readonly AssayUnit[] = ["g/t", "ppm", "%", "mg/kg", "other"];

export type GeophysicsSurveyType =
  "magnetics" | "ip" | "resistivity" | "em" | "gravity" | "radiometrics" | "other";
export const GEOPHYSICS_SURVEY_TYPES: readonly GeophysicsSurveyType[] =
  ["magnetics", "ip", "resistivity", "em", "gravity", "radiometrics", "other"];

export type RemoteSensingSource = "sentinel2" | "sentinel1" | "landsat" | "dem" | "other";
export const REMOTE_SENSING_SOURCES: readonly RemoteSensingSource[] =
  ["sentinel2", "sentinel1", "landsat", "dem", "other"];

/** A. Laboratory / assay — zero or more results, each independently sourced. */
export interface AssayEntry {
  id: string;
  element: string; // free text — "Au", "Sn", "Cu"; commodity-agnostic by design
  result: number | null;
  unit: AssayUnit;
  sampleType: string;
  sampleId: string;
  location: { lat: number; lng: number } | null;
  samplingDate: string | null; // ISO date
  verificationStatus: VerificationStatus;
  /**
   * The gate for `lab_verified`. Entering a lab name and a result does NOT set
   * this — it is a distinct, explicit flag. Without it, a "lab_verified"
   * `verificationStatus` claim is downgraded to `expert_verified` at scoring
   * time (see structuredEvidenceSource.ts) rather than trusted at face value.
   */
  labAccredited: boolean;
  labName: string;
  notes: string;
}

/** B. Ground geophysics / verified survey. */
export interface GeophysicsEntry {
  id: string;
  surveyType: GeophysicsSurveyType;
  anomalyPresent: boolean;
  anomalyDescription: string;
  magnitude: number | null;
  surveyArea: string;
  location: { lat: number; lng: number } | null;
  interpretation: string;
  verificationStatus: VerificationStatus;
  notes: string;
}

/** C. Detailed geological mapping. */
export interface MappingEntry {
  id: string;
  hostLithology: string;
  rockType: string;
  formationUnit: string;
  alteration: string;
  veinType: string;
  veinWidthM: number | null;
  veinOrientation: string;
  strikeDeg: number | null;
  dipDeg: number | null;
  fault: boolean;
  shearZone: boolean;
  fold: boolean;
  breccia: boolean;
  gossan: boolean;
  sulfides: boolean;
  visibleMineralization: string;
  mineralAssemblage: string;
  structuralRelationship: string;
  mappingConfidence: VerificationStatus;
  notes: string;
}

/** D. Remote sensing interpretation. */
export interface RemoteSensingEntry {
  id: string;
  source: RemoteSensingSource;
  alterationAnomaly: string;
  spectralAnomaly: string;
  structuralAnomaly: string;
  lineamentInterpretation: string;
  imageDate: string | null;
  areaCovered: string;
  interpretation: string;
  confidence: VerificationStatus;
  notes: string;
}

/**
 * What the geologist SPECIFICALLY CHECKED FOR and confirmed was not there.
 *
 * The one and only source of negative evidence in the whole system
 * (Architecture: Integrated Prospectivity Score, Priority 1). Every field is
 * a tri-state by omission: `undefined` (the default — not asked, not
 * answered) is NOT evidence of anything. Only an explicit `true`, set by a
 * deliberate toggle in the form, becomes a negative evidence item.
 *
 * "The user did not mention alteration" and "the user checked and confirmed
 * no alteration" are different claims, and this type is what keeps them
 * different — there is no code path anywhere that upgrades the first into
 * the second. See structuredEvidenceSource.ts's
 * `confirmedAbsentToObservations()`, the ONLY function that reads this.
 */
export interface ConfirmedAbsentFindings {
  alteration?: boolean;
  sulfides?: boolean;
  quartzVein?: boolean;
  visibleMineralization?: boolean;
  /** No fault, shear zone, or other structural control observed nearby. */
  favorableStructure?: boolean;
  /** A geochemical anomaly was specifically tested for (e.g. panning, field kit) and absent. */
  geochemicalAnomaly?: boolean;
}

/** E. Expert / field observation — direct, structured indicators. */
export interface FieldObservationEntry {
  id: string;
  visibleMineral: boolean;
  quartzVein: boolean;
  gossanRust: boolean;
  sulfides: boolean;
  alteration: boolean;
  shearing: boolean;
  faultExposure: boolean;
  oldWorkings: boolean;
  activeArtisanalMining: boolean;
  pits: boolean;
  shafts: boolean;
  adits: boolean;
  tailings: boolean;
  historicalProduction: boolean;
  localMiningEvidence: boolean;
  otherObservations: string;
  expertInterpretation: string;
  confidence: VerificationStatus;
  notes: string;
  /** Absent (not even an empty object) is the common case — nothing was specifically checked. */
  confirmedAbsent?: ConfirmedAbsentFindings;
}

/**
 * One User Geological Evidence record. All five sections are optional arrays —
 * an empty array means "nothing entered", not "checked and found none" (that
 * distinction belongs to the coverage panel, not to this record).
 */
export interface StructuredGeologicalEvidence {
  id: string;
  missionId: string;
  /**
   * The physical site this evidence is anchored to — a waypoint id or a
   * `WaypointSample.sampleId` when tied to a specific specimen, or the mission id
   * itself when entered before a specific sample exists (Phase 9 step 4: entered
   * before field investigation starts). This is the `siteAnchorId` the grouping
   * functions in integratedProspectivity.ts key on.
   */
  siteId: string;
  commodity: string | null;
  createdAt: number;
  updatedAt: number;
  assays: AssayEntry[];
  geophysics: GeophysicsEntry[];
  mapping: MappingEntry[];
  remoteSensing: RemoteSensingEntry[];
  fieldObservations: FieldObservationEntry[];
}

/** What one save of the form produces — at most one new entry per section. */
export interface StructuredEvidenceResult {
  assay: AssayEntry | null;
  geophysics: GeophysicsEntry | null;
  mapping: MappingEntry | null;
  remoteSensing: RemoteSensingEntry | null;
  fieldObservation: FieldObservationEntry | null;
}

export function emptyStructuredEvidence(
  missionId: string, siteId: string, commodity: string | null, now: number,
): StructuredGeologicalEvidence {
  return {
    id: `sge-${missionId}`, missionId, siteId, commodity,
    createdAt: now, updatedAt: now,
    assays: [], geophysics: [], mapping: [], remoteSensing: [], fieldObservations: [],
  };
}

/** True when every section is empty — the record carries nothing yet. */
export function isEmptyStructuredEvidence(e: StructuredGeologicalEvidence): boolean {
  return e.assays.length === 0 && e.geophysics.length === 0 && e.mapping.length === 0 &&
    e.remoteSensing.length === 0 && e.fieldObservations.length === 0;
}

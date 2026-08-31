// What KIND of evidence a prospectivity item is — one vocabulary, used everywhere.
//
// The score has always been a single number with no account of what went into it.
// A cell scoring 0.6 from one fault reads exactly like a cell scoring 0.6 from
// geology, structure, terrain and three occurrences agreeing. A geologist deciding
// whether to drive four hours needs to know which of those they are looking at.
//
// These roles are also what makes the leakage detector possible: to ask "does this
// layer's mere PRESENCE predict a known occurrence?" the engine has to be able to
// say which layer each item came from.
export type EvidenceRole =
  | "geology"        // mapped lithological units
  | "structural"     // faults
  | "contacts"       // unit boundaries — where units meet
  | "lineaments"     // inferred structures
  | "occurrence"     // mapped mineral occurrences
  | "association"    // commodity <-> host-rock knowledge
  | "terrain"        // DEM derivatives: elevation, slope, aspect, morphology
  | "drainage"       // hydrology
  | "field"          // the geologist's own observations
  | "community"      // verified finds recorded nearby
  | "geochemistry"
  | "geophysics"
  | "remote_sensing";

/** Every role the engine can consume, in the order a report should read them. */
export const EVIDENCE_ROLES: readonly EvidenceRole[] = [
  "geology", "structural", "contacts", "lineaments",
  "occurrence", "association", "terrain", "drainage",
  "field", "community",
  "geochemistry", "geophysics", "remote_sensing",
] as const;

/**
 * How a role stands AT A PARTICULAR PLACE — four states, and the distinctions
 * between them are the whole point.
 *
 *   present      data of this kind is within range here, and it was used.
 *   not_scored   the data IS here, and the engine does not put it into the
 *                score. Two reasons today, both deliberate and both worth
 *                saying out loud rather than looking like absence.
 *   none_here    the layer is populated, and nothing of it is near this point.
 *                A real measurement: "there are mapped faults in this country,
 *                just none within 10 km of you."
 *   empty_layer  the pack carries this layer and it has ZERO rows, anywhere.
 *                Nobody has loaded the data yet. Different from `none_here` in
 *                the way that matters: one is about this place, the other is
 *                about the whole dataset.
 *   no_source    there is no data source for this at all. Not missing — never
 *                collected.
 *
 * Collapsing these into "missing" would let the app say "no alteration here"
 * when the truth is "alteration was never looked for", which is the difference
 * between a geological assistant and a confident liar.
 */
export type CoverageState =
  | "present" | "not_scored" | "none_here" | "empty_layer" | "no_source";

/**
 * Roles whose data the pack holds and the engine deliberately does not score.
 *
 * A role joins this list for a MEASURED reason and leaves it for a measured one.
 * It is the ONE authority: the scorer skips these roles and the coverage panel
 * reports them, so a layer cannot enter the score by the side door simply because
 * its rows arrived.
 *
 *   contacts  ADMISSION PENDING. Held here from the moment the derivation was
 *             written, so that landing the data could not silently switch on a
 *             term that has never been leakage- or usefulness-tested. It leaves
 *             when both gates pass, and not before.
 *
 *   drainage  DERIVED AND VALIDATED, AND IT CARRIES NO SIGNAL. 16,870 reaches
 *             from the Copernicus DEM, 300,684 km at 0.47 km/km2 — a credible
 *             semi-arid network — and every terrain cell now has a real distance
 *             to it. Coverage passes the leakage test at ratio 1.36.
 *
 *             It is not scored because the usefulness test says it earns nothing:
 *             occurrence enrichment by distance-to-channel is 1.11, 1.18, 0.86,
 *             1.03, 1.01 across the bands — flat, which is another way of saying
 *             the occurrences are placed with respect to drainage exactly as
 *             random ground is.
 *
 *             AND THE PLACER HYPOTHESIS CANNOT BE TESTED HERE. Drainage should
 *             matter enormously for alluvial systems, but the label set contains
 *             ZERO occurrences described as placer or alluvial, and 143 of 159
 *             carry no deposit_type at all. So the honest statement is not
 *             "drainage does not matter" — it is "this dataset cannot show
 *             whether it does". It waits for commodity conditioning, where a
 *             placer profile can weight it on geological grounds rather than on
 *             a correlation that is not in the data.
 *
 * `terrain` left on 11 August 2026: the DEM had been sampled in a k-ring around
 * each known occurrence (ratio 150), country-wide Copernicus brought it to 1.37,
 * and the admission gate showed it lifts the blind AUC from 0.810 to 0.843.
 *
 * `geology` left on 10 August 2026, for a reason that was half right: scoring
 * well-MAPPED ground rewards survey coverage. Scoring its rock CLASS does not —
 * 75% of occurrences in 11% of the area, leakage ratio 0.99.
 */
/**
 * `lineaments` withheld on 18 August 2026, on the same measurement as contacts.
 * The 5,960 Copernicus GLO-30 DEM-derived lineaments leak 4.3x (present at 69% of
 * occurrences, 16% of background). They are extracted FROM the DEM, and the engine
 * already scores that DEM as `terrain` — so scoring lineament coverage double-counts
 * the landform signal rather than adding an independent one. They remain CONTEXT:
 * drawn on the map, reported in the coverage/evidence panel, never fed to the score.
 */
export const ROLES_NOT_SCORED: readonly EvidenceRole[] = ["drainage", "contacts", "lineaments"] as const;

/**
 * Roles with no data source anywhere in the system today.
 *
 * `geochemistry` and `geophysics` left this list once the structured User
 * Geological Evidence form (Stage 3, Architecture: Integrated Prospectivity
 * Score) gave them a real, if user-reported, source — see `packCoverage()`
 * below, which now treats them like `field`: the pack can never be the reason
 * they are unavailable, because neither ever came from the pack.
 *
 * `remote_sensing` stays here for now even though the same form also captures
 * it (Section D): its evidence is produced but deliberately excluded from
 * scoring pending the Stage 6 admission gate (see
 * INTEGRATED_ROLES_PENDING_ADMISSION in structuredEvidenceSource.ts), and its
 * coverage-panel treatment is revisited together with that gate rather than
 * half-done here.
 */
export const ROLES_WITHOUT_SOURCE: readonly EvidenceRole[] = ["remote_sensing"] as const;

export const ROLE_LABEL_KEY = (r: EvidenceRole): string => `field.evidenceRole.${r}`;
export const COVERAGE_STATE_KEY = (s: CoverageState): string => `field.coverage.${s}`;

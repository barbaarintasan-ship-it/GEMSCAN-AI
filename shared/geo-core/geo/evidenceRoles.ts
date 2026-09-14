// What KIND of evidence a prospectivity item is — one vocabulary, used everywhere.
//
// MOVED from mobile/lib/geo/evidenceRoles.ts (Solo→Team shared-targeting Phase 1)
// so the SAME vocabulary is available to server-side scoring. Zero runtime
// dependencies, so the move is a pure relocation — see mobile/lib/geo/evidenceRoles.ts
// for the re-export shim that keeps every existing Solo import unchanged.
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
 * See mobile/lib/geo/evidenceRoles.ts's original comment for the full
 * measurement history behind each entry (contacts/drainage/lineaments) — that
 * history is Solo-pack-specific, so it stays with the shim rather than being
 * duplicated here. The LIST itself is the one authority both runtimes read.
 */
export const ROLES_NOT_SCORED: readonly EvidenceRole[] = ["drainage", "contacts", "lineaments"] as const;

/** Roles with no data source anywhere in the system today. */
export const ROLES_WITHOUT_SOURCE: readonly EvidenceRole[] = ["remote_sensing"] as const;

export const ROLE_LABEL_KEY = (r: EvidenceRole): string => `field.evidenceRole.${r}`;
export const COVERAGE_STATE_KEY = (s: CoverageState): string => `field.coverage.${s}`;

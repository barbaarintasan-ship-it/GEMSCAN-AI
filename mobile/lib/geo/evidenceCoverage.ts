// What the score was built from, and what it was NOT built from.
//
// The measured position on 10 August 2026: strip out mineral occurrences and the
// engine cannot tell mineralised ground from random ground (AUC 0.53), because
// 90.4% of all ground has no evidence of any kind. Four of the pack's layers ship
// with zero rows and three roles have no data source at all — and none of that
// was visible anywhere in the app. A score of 0.72 looked identical whether it
// came from ten agreeing layers or from one fault.
//
// So every prospectivity result now carries its own basis. Not as a warning
// banner, but as a count a geologist can read before deciding to drive four hours:
//
//     Prospectivity 72/100      Evidence 4/13
//     present    geology, structural, occurrence, field
//     none here  community
//     no rows    contacts, lineaments, drainage, association
//     no source  geochemistry, geophysics, remote sensing
//
// This file DERIVES that; it never asserts it. `packCoverage` reads the pack's
// actual row counts, and `coverageAt` is told which roles genuinely produced
// evidence at the point. Nothing here can claim a layer contributed when it did
// not.
import {
  EVIDENCE_ROLES, ROLES_NOT_SCORED, ROLES_WITHOUT_SOURCE,
  type CoverageState, type EvidenceRole,
} from "./evidenceRoles";
import { terrainAt, unitAt } from "./featureInfo";
import { featuresNear } from "./terrainProviders";
import { haversineM } from "../../../shared/geo-core/geo/spatial";
import type { PackData } from "../../../shared/geo-core/pack/types";

/** The range within which a layer counts as having something to say here. */
export const DEFAULT_COVERAGE_RADIUS_M = 10_000;

export interface RoleCoverage {
  role: EvidenceRole;
  state: CoverageState;
}

export interface EvidenceCoverage {
  roles: RoleCoverage[];
  /** Roles that contributed here. */
  present: number;
  /** Every role the engine knows how to consume. */
  total: number;
  /**
   * Roles that could not contribute ANYWHERE with this pack — empty layers plus
   * roles with no source. This is a property of the data, not of the place, and
   * it is the number that says how complete the model can possibly be today.
   */
  unavailable: EvidenceRole[];
}

/**
 * Which roles this pack could ever supply, before any location is considered.
 *
 * A layer with zero rows is `empty_layer` at every point on Earth, and saying so
 * once is more honest than saying "nothing here" a thousand times.
 */
export function packCoverage(pack: PackData): Map<EvidenceRole, CoverageState> {
  const out = new Map<EvidenceRole, CoverageState>();

  // mapFeatures is one table holding four different kinds; each is its own role,
  // and each can be independently empty. Today: 96 faults, and nothing else.
  const kinds = new Set((pack.mapFeatures ?? []).map((f) => f.kind));

  const rows: Record<EvidenceRole, number> = {
    geology: pack.geology?.length ?? 0,
    structural: kinds.has("fault") ? 1 : 0,
    contacts: kinds.has("contact") ? 1 : 0,
    lineaments: kinds.has("lineament") ? 1 : 0,
    occurrence: pack.occurrences?.length ?? 0,
    association: pack.associations?.length ?? 0,
    terrain: pack.terrain?.length ?? 0,
    drainage: kinds.has("drainage") ? 1 : 0,
    // Field observations, structured lab/geophysics evidence, and structured
    // remote-sensing interpretations are made by the geologist, not shipped in a
    // pack: the pack can never be the reason these roles are unavailable. (See
    // ROLES_WITHOUT_SOURCE — remote_sensing still routes through that separate
    // "no_source" path pending the Stage 6 scoring admission gate, so its row
    // value here is never read.)
    field: 1,
    community: pack.community?.length ?? 0,
    geochemistry: 1,
    geophysics: 1,
    remote_sensing: 0,
  };

  for (const role of EVIDENCE_ROLES) {
    if (ROLES_WITHOUT_SOURCE.includes(role)) { out.set(role, "no_source"); continue; }
    out.set(role, rows[role] > 0 ? "present" : "empty_layer");
  }
  return out;
}

/**
 * Coverage at one place.
 *
 * `produced` is the set of roles that actually emitted evidence at this point —
 * passed in rather than recomputed, so the report and the score can never
 * disagree about what was used.
 */
export function coverageAt(
  pack: PackData,
  produced: ReadonlySet<EvidenceRole>,
  at?: { lat: number; lng: number },
  radiusM = DEFAULT_COVERAGE_RADIUS_M,
): EvidenceCoverage {
  const inPack = packCoverage(pack);
  // One definition of "the layer has something to say here", shared with the
  // leakage detector so the two can never drift apart.
  const hasData = at ? dataRolesAt(pack, at, radiusM) : new Set<EvidenceRole>();

  const roles: RoleCoverage[] = EVIDENCE_ROLES.map((role) => {
    const available = inPack.get(role) ?? "empty_layer";
    if (available !== "present") return { role, state: available };

    // PRODUCED WINS. A role in the not-scored list can still contribute when a
    // commodity profile makes it relevant — drainage does exactly that for a
    // placer deposit model — and reporting it as withheld while it is in the
    // score would be the panel contradicting the number beside it.
    if (produced.has(role)) return { role, state: "present" };

    // A role the engine holds and does not score in this assessment.
    if (ROLES_NOT_SCORED.includes(role)) {
      return { role, state: hasData.has(role) ? "not_scored" : "none_here" };
    }

    // PRESENT means the layer was consulted and had data — not that it pushed the
    // score up. Mapped geology answering "this is Cenozoic cover, unprospective"
    // has answered the question, and reporting that as missing data would tell a
    // geologist the app knows less than it does.
    return { role, state: hasData.has(role) ? "present" : "none_here" };
  });

  return {
    roles,
    present: roles.filter((r) => r.state === "present").length,
    total: EVIDENCE_ROLES.length,
    unavailable: roles
      .filter((r) => r.state === "empty_layer" || r.state === "no_source")
      .map((r) => r.role),
  };
}

/**
 * Which roles the pack physically HOLDS data for at this point — regardless of
 * whether any of it was scored.
 *
 * A DIFFERENT QUESTION from `coverageAt`, and keeping them apart matters. Coverage
 * answers "what informed this score", which is what a geologist reads. This
 * answers "what data exists here", which is what the leakage detector needs.
 *
 * Conflating them produced a false alarm the moment geology started being scored:
 * `present` became "produced evidence", evidence output correlates with
 * occurrences by construction — that is a model working, not a leak — and the
 * detector reported geology at ratio 10.6 when its actual coverage ratio is 0.99.
 * A detector that fires on every layer that works is a detector nobody will keep.
 */
export function dataRolesAt(
  pack: PackData,
  at: { lat: number; lng: number },
  radiusM: number,
): Set<EvidenceRole> {
  const out = new Set<EvidenceRole>();
  if (unitAt(pack, at)) out.add("geology");
  if (terrainAt(pack, at)) out.add("terrain");

  const near = featuresNear(pack.mapFeatures ?? [], at.lat, at.lng, radiusM);
  for (const f of near) {
    if (f.kind === "fault") out.add("structural");
    else if (f.kind === "contact") out.add("contacts");
    else if (f.kind === "lineament") out.add("lineaments");
    else if (f.kind === "drainage") out.add("drainage");
  }

  if ((pack.occurrences ?? []).some((o) => haversineM(at, { lat: o.lat, lng: o.lng }) <= radiusM)) {
    out.add("occurrence");
  }
  if ((pack.community ?? []).some((c) => haversineM(at, { lat: c.lat, lng: c.lng }) <= radiusM)) {
    out.add("community");
  }
  if ((pack.associations ?? []).length > 0) out.add("association");
  // field, geochemistry, geophysics and remote_sensing are never in a pack.
  return out;
}

/** Roles in one state, for a report that groups rather than lists thirteen lines. */
export function rolesInState(c: EvidenceCoverage, state: CoverageState): EvidenceRole[] {
  return c.roles.filter((r) => r.state === state).map((r) => r.role);
}

/**
 * A score built on very little should not read like one built on a lot.
 *
 * Deliberately a plain fraction rather than a factor applied to the score: the
 * score means what it means, and the app must not quietly discount a number and
 * then show the discounted value as if it were a measurement. The reader is told
 * the basis and draws their own conclusion.
 */
export function coverageFraction(c: EvidenceCoverage): number {
  return c.total === 0 ? 0 : c.present / c.total;
}

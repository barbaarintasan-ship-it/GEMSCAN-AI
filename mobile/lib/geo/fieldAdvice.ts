// What to do in the next few hundred metres.
//
// The engine answers "where should I walk?"; this answers the smaller question a
// geologist asks constantly on the way there — what is worth stopping for, what
// is worth photographing, what this ground is likely to expose. It updates as
// the position updates, because the answer changes as you cross a contact or
// drop into a drainage.
//
// THE RULE
// --------
// Every line has a BASIS: the pack row it came from, named in the output, and
// the screen shows it. Nothing here invents a deposit, a fault or a confidence.
// Where the pack is silent this returns fewer lines rather than vaguer ones — a
// short honest list is worth more in the field than a full page of hedging.
//
// The geological readings themselves (slope, morphology, drainage distance,
// lithology, mapped features) are DEM derivatives and map records carried in the
// pack. The interpretation attached to each — steep ground exposes bedrock,
// drainage collects heavy minerals, faults host veins — is standard prospecting
// practice, stated as guidance and always beside the measurement it came from,
// never dressed up as a finding.
import { compassPoint } from "../../../shared/geo-core/geo/spatial.ts";

/** What kind of advice this is. The screen maps each to an icon and a phrase. */
export type AdviceKind =
  | "continue_to_target"
  | "inspect_fault"
  | "inspect_contact"
  | "drainage_trap"
  | "steep_outcrop"
  | "ridge_outcrop"
  | "valley_float"
  | "host_association"
  | "occurrence_ahead"
  | "capture_evidence";

export interface Advice {
  /** Stable across recomputes, so the list does not re-key on every fix. */
  id: string;
  kind: AdviceKind;
  /** Interpolation values for the i18n string that renders this kind. */
  params: Record<string, string | number>;
  /**
   * Where this came from, as a translatable key plus its values.
   *
   * Invariant 2 — no unexplained recommendation. A line the geologist cannot
   * trace back to a pack row is a line they are being asked to trust blindly.
   */
  basis: { key: string; params?: Record<string, string | number> };
  /** 0..1. An ordering, not a probability — see the note on RegionalTarget. */
  priority: number;
}

export interface AdviceInput {
  /** Nearest DEM cell, when one is close enough to describe this ground. */
  terrain: {
    slopeDeg: number;
    morphology: string;
    drainageDistM: number | null;
    fromM: number;
  } | null;
  /** The mapped unit underfoot, and what the pack associates with its lithology. */
  unit: {
    name: string;
    lithology: string | null;
    associated: Array<{ commodity: string; weight: number | null }>;
  } | null;
  /** Nearest mapped fault, at any distance. */
  fault: { distanceM: number; bearingDeg: number; name: string | null } | null;
  /** Nearest mapped contact, when the pack carries contacts. */
  contact: { distanceM: number; bearingDeg: number } | null;
  /** Nearest mapped mineral occurrence, at any distance. */
  occurrence: { distanceM: number; bearingDeg: number; commodity: string | null } | null;
  /** Where the engine is currently sending the geologist, if anywhere. */
  target: { distanceM: number; bearingDeg: number } | null;
  /** Observations already recorded within `EVIDENCE_NEARBY_M` of here. */
  evidenceNearby: number;
}

/** Inside this, a feature is worth a detour on foot rather than a drive. */
export const WALKABLE_M = 800;
/** A drainage this close is reachable without leaving the traverse. */
export const DRAINAGE_NEAR_M = 300;
/** Slope at which bedrock is usually exposed rather than covered. */
export const STEEP_SLOPE_DEG = 25;
/** How far away an existing observation still counts as covering this ground. */
export const EVIDENCE_NEARBY_M = 250;
/** Past this a DEM cell describes other ground and is not interpreted. */
export const TERRAIN_TRUST_M = 3_000;

/** How many lines the sheet shows. A list nobody reads is not guidance. */
export const MAX_ADVICE = 5;

/**
 * Rank what is worth doing here, best first.
 *
 * Pure: same input, same output, no clock and no I/O. The caller decides how
 * often to run it — see the exploration screen, which recomputes on movement
 * rather than on every fix.
 */
export function fieldAdvice(input: AdviceInput): Advice[] {
  const out: Advice[] = [];
  const push = (a: Advice) => out.push(a);

  if (input.target) {
    const c = compassPoint(input.target.bearingDeg);
    push({
      id: "target",
      kind: "continue_to_target",
      params: { distanceM: Math.round(input.target.distanceM), compass: c },
      basis: { key: "field.advice.basis.engine" },
      priority: 1,
    });
  }

  if (input.fault && input.fault.distanceM <= WALKABLE_M) {
    push({
      id: "fault",
      kind: "inspect_fault",
      params: {
        distanceM: Math.round(input.fault.distanceM),
        compass: compassPoint(input.fault.bearingDeg),
        name: input.fault.name ?? "",
      },
      basis: { key: "field.advice.basis.mappedFault" },
      priority: 0.9 - input.fault.distanceM / (WALKABLE_M * 10),
    });
  }

  if (input.contact && input.contact.distanceM <= WALKABLE_M) {
    push({
      id: "contact",
      kind: "inspect_contact",
      params: {
        distanceM: Math.round(input.contact.distanceM),
        compass: compassPoint(input.contact.bearingDeg),
      },
      basis: { key: "field.advice.basis.mappedContact" },
      priority: 0.78 - input.contact.distanceM / (WALKABLE_M * 10),
    });
  }

  if (input.occurrence && input.occurrence.distanceM <= WALKABLE_M * 3) {
    push({
      id: "occurrence",
      kind: "occurrence_ahead",
      params: {
        distanceM: Math.round(input.occurrence.distanceM),
        compass: compassPoint(input.occurrence.bearingDeg),
        commodity: input.occurrence.commodity ?? "",
      },
      basis: { key: "field.advice.basis.mappedOccurrence" },
      priority: 0.85 - input.occurrence.distanceM / (WALKABLE_M * 30),
    });
  }

  // Terrain is only interpreted where the DEM actually describes this ground.
  const t = input.terrain && input.terrain.fromM <= TERRAIN_TRUST_M ? input.terrain : null;
  if (t) {
    const basis = { key: "field.advice.basis.dem", params: { fromM: Math.round(t.fromM) } };

    if (t.drainageDistM != null && t.drainageDistM <= DRAINAGE_NEAR_M) {
      push({
        id: "drainage",
        kind: "drainage_trap",
        params: { distanceM: Math.round(t.drainageDistM) },
        basis: { key: "field.advice.basis.drainage", params: { fromM: Math.round(t.fromM) } },
        priority: 0.72,
      });
    }
    if (t.slopeDeg >= STEEP_SLOPE_DEG) {
      push({
        id: "slope",
        kind: "steep_outcrop",
        params: { slopeDeg: Math.round(t.slopeDeg) },
        basis,
        priority: 0.66,
      });
    } else if (t.morphology === "ridge") {
      push({ id: "ridge", kind: "ridge_outcrop", params: {}, basis, priority: 0.6 });
    } else if (t.morphology === "valley") {
      push({ id: "valley", kind: "valley_float", params: {}, basis, priority: 0.55 });
    }
  }

  if (input.unit?.lithology && input.unit.associated.length > 0) {
    push({
      id: "association",
      kind: "host_association",
      params: {
        lithology: input.unit.lithology,
        unit: input.unit.name,
        commodities: input.unit.associated.map((a) => a.commodity).join(", "),
      },
      basis: { key: "field.advice.basis.association" },
      priority: 0.5,
    });
  }

  // Only where there is a reason to stop at all: telling someone to photograph
  // ground that nothing else on this list finds interesting is noise.
  if (input.evidenceNearby === 0 && out.length > 0) {
    push({
      id: "capture",
      kind: "capture_evidence",
      params: {},
      basis: { key: "field.advice.basis.noEvidence", params: { radiusM: EVIDENCE_NEARBY_M } },
      priority: 0.45,
    });
  }

  out.sort((a, b) => b.priority - a.priority);
  return out.slice(0, MAX_ADVICE);
}

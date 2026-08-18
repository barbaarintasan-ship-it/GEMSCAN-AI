// The exploration MISSION — what a target actually is, from choosing it to
// closing it.
//
// This sits ABOVE the engine and changes nothing inside it. Prospectivity
// scoring, the commodity model and the validation baseline are untouched; this
// only decides what the app does with a target once a geologist has one.
//
// WHY A SEPARATE STATE MACHINE
//
// `ExplorationState` describes the SESSION — is the GPS up, is a re-score
// running. That is a different subject from "how far through investigating this
// target am I", and conflating them is what let arrival read as the end of the
// job. Arriving in a target's cell is the START of the work: you have reached
// five square kilometres of ground, and nothing has been looked at yet.
//
// THE RULE THAT MATTERS
//
// From TARGET_SELECTED until MISSION_CLOSED, the destination is the geologist's,
// not the ranking's. `TargetCommitment` in the orchestrator enforces that per
// re-rank; this enforces it across the whole mission, including the part after
// arrival where there is no navigation left to protect.

/**
 * Where the mission is. Ordered as it is lived.
 *
 *   none                      no mission; the engine may recommend freely
 *   target_selected           a target is chosen and locked
 *   navigating                travelling to it
 *   arrived_at_target_area    inside the target cell — the work begins here
 *   field_investigation       collecting evidence on the ground
 *   section_completed         the geologist called it done; a package was built
 *   waiting_for_upload        the package is on the device, waiting for a network
 *   ai_analysis_complete      the assessment came back
 *   mission_closed            finished. Only now may a new target be recommended.
 */
export type MissionState =
  | "none"
  | "target_selected"
  | "navigating"
  | "arrived_at_target_area"
  | "field_investigation"
  | "section_completed"
  | "waiting_for_upload"
  | "ai_analysis_complete"
  | "mission_closed";

export const MISSION_STATES: readonly MissionState[] = [
  "none", "target_selected", "navigating", "arrived_at_target_area",
  "field_investigation", "section_completed", "waiting_for_upload",
  "ai_analysis_complete", "mission_closed",
] as const;

/**
 * Legal moves, and only these.
 *
 * `abandon` is deliberately allowed from every live state: a geologist who has to
 * leave must be able to, and a machine with no exit is a machine people work
 * around. It goes to `mission_closed`, so the package that was already built is
 * still uploaded and still analysed — abandoning the walk does not discard the
 * evidence.
 */
const TRANSITIONS: Record<MissionState, readonly MissionState[]> = {
  none: ["target_selected"],
  target_selected: ["navigating", "arrived_at_target_area", "mission_closed"],
  // Arrival can be reported straight from selection when the geologist is
  // already standing in the cell they picked — which happens, and refusing it
  // would strand them in "navigating" with nowhere to go.
  navigating: ["arrived_at_target_area", "mission_closed"],
  arrived_at_target_area: ["field_investigation", "mission_closed"],
  field_investigation: ["section_completed", "mission_closed"],
  section_completed: ["waiting_for_upload", "ai_analysis_complete", "mission_closed"],
  waiting_for_upload: ["ai_analysis_complete", "mission_closed"],
  ai_analysis_complete: ["mission_closed"],
  mission_closed: ["none", "target_selected"],
};

export function canTransition(from: MissionState, to: MissionState): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * A mission is live from the moment a target is taken until it is closed.
 *
 * The single question the rest of the app asks: may the engine hand out a
 * different target? Only when the answer is no.
 */
export function isMissionLive(s: MissionState): boolean {
  return s !== "none" && s !== "mission_closed";
}

/** Whether the geologist is on the ground and collecting, rather than travelling. */
export function isOnSite(s: MissionState): boolean {
  return s === "arrived_at_target_area" || s === "field_investigation";
}

/** Whether the mission is done being worked and is now moving through delivery. */
export function isDelivering(s: MissionState): boolean {
  return s === "section_completed" || s === "waiting_for_upload" ||
    s === "ai_analysis_complete";
}

export interface Mission {
  /** Stable for the life of the mission; the package's identity. */
  id: string;
  state: MissionState;
  /** The H3 cell being investigated — the target AREA. */
  cell: string;
  /** Centre of that cell, for navigation when there is no hotspot. */
  centre: { lat: number; lng: number };
  /**
   * The best point to stand INSIDE the area, when the evidence singles one out.
   *
   * Null is a real answer and the common one: five square kilometres of
   * uniformly-scoring ground has no hotspot, and inventing a point in the middle
   * of it would be a fabricated recommendation.
   */
  hotspot: MissionHotspot | null;
  /** The commodity the assessment was conditioned on, or null for universal. */
  commodity: string | null;
  /** The prospectivity score of the target cell when the mission was taken. RANKING. */
  score: number;
  /**
   * The DISPLAY score for the report — `score` moderated by evidence breadth and
   * completeness (prospectivityReport.ts). Never used for ranking. Optional so a
   * mission restored from an older store falls back to `score` at the read site.
   */
  reportScore?: number;
  startedAt: number;
  arrivedAt: number | null;
  completedAt: number | null;
  closedAt: number | null;
  /** Set once a package exists on the device. */
  packageId: string | null;
}

export interface MissionHotspot {
  lat: number;
  lng: number;
  /** The finer H3 cell it sits in — the evidence is per-cell, so this is its id. */
  cell: string;
  score: number;
  /**
   * How much better than the target cell's own centre.
   *
   * Carried so the screen can be honest about the size of the claim: a hotspot
   * 0.05 better is a nudge, not a discovery.
   */
  liftOverCentre: number;
}

export function newMission(
  id: string,
  cell: string,
  centre: { lat: number; lng: number },
  opts: { commodity: string | null; score: number; reportScore?: number; at: number },
): Mission {
  return {
    id, state: "target_selected", cell, centre,
    hotspot: null, commodity: opts.commodity, score: opts.score,
    reportScore: opts.reportScore ?? opts.score,
    startedAt: opts.at, arrivedAt: null, completedAt: null, closedAt: null,
    packageId: null,
  };
}

/**
 * Move a mission on, or refuse.
 *
 * Refusing returns the mission unchanged rather than throwing: an illegal
 * transition is a bug in a caller, and crashing a geologist's field session over
 * it would be the worse outcome. Callers that care can compare identity.
 */
export function advance(m: Mission, to: MissionState, at: number): Mission {
  if (!canTransition(m.state, to)) return m;
  return {
    ...m,
    state: to,
    arrivedAt: to === "arrived_at_target_area" && m.arrivedAt == null ? at : m.arrivedAt,
    completedAt: to === "section_completed" ? at : m.completedAt,
    closedAt: to === "mission_closed" ? at : m.closedAt,
  };
}

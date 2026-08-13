// What a finished section hands over.
//
// FINISH SECTION does not send anything. It assembles everything the mission
// produced into one record and writes it to the device — because the field has no
// network, and a workflow that only completes when it can reach a server is a
// workflow that loses a day's work in a valley.
//
// The package is the unit of delivery AND the unit of analysis: exactly what is
// stored is exactly what the AI geologist is later given, so an assessment can
// always be traced back to the evidence that produced it, offline, months later.
//
// WHAT IS NOT IN HERE
//
// No interpretation. No score for the observations. No conclusion. The package is
// the raw material — measurements, photographs, the engine's own reasoning about
// the ground, and an honest statement of what was never looked at. Turning that
// into geology is the analysis step's job, and doing any of it here would mean the
// analysis was partly written by the thing collecting the data.
import type { Waypoint } from "../field/waypointTypes";
import type { EvidenceCoverage } from "../geo/evidenceCoverage";
import type { TargetReason } from "../geo/targeting";
import type { Mission, MissionHotspot } from "./mission";
import type { MissionFindings } from "../../../shared/geo-core/gie/missionFindings";

/** Bumped when the shape changes, so an old package on a device stays readable. */
export const EVIDENCE_PACKAGE_VERSION = 2;

/**
 * What the offline engine measured about this ground, at the moment the section
 * was finished.
 *
 * WHY THESE TRAVEL, and why their absence was a real defect.
 *
 * The analysis prompt asks for exactly these four readings. The package carried
 * none of them, so the server passed null for each, and the prompt renders null
 * as NOT AVAILABLE — which the model then reports as MISSING EVIDENCE. The app
 * was telling a geologist that nobody had looked at the elevation, the faults,
 * the contacts or the drainage, when the engine had measured all four before it
 * ever offered them the target.
 *
 * "Measured and absent" and "never measured" are different findings, and this is
 * the difference. A value that genuinely has no answer here — no mapped fault
 * within range — stays null, and NOT AVAILABLE is then the truth.
 *
 * READ, never computed. Every one comes from a pack lookup that already exists
 * (`terrainAt`, `nearestLineOfKind`). No provider runs, nothing is scored, and no
 * ranking is consulted: these are facts about the ground, not an opinion of it.
 */
export interface EngineReadings {
  elevationM: number | null;
  /** Metres to the nearest mapped fault, or null when none is in range. */
  faultDistanceM: number | null;
  contactDistanceM: number | null;
  drainageDistanceM: number | null;
}

export interface PackageObservation {
  id: string;
  type: string;
  notes: string;
  capturedAt: number;
  /** Null when the sky was blocked. The observation still happened. */
  position: {
    lat: number; lng: number;
    accuracyM: number | null;
    altitudeM: number | null;
    /** How old the fix was when the observation was taken. */
    ageMs: number;
    provisional: boolean;
  } | null;
  /** Quality is DERIVED and carried, so nothing downstream has to re-judge it. */
  positionQuality: string;
  /**
   * "observed" if this phone was there, "reported" if somebody else was.
   *
   * Carried to the model deliberately. The rest of this package reads as an
   * eyewitness account — position from the receiver, photographs from the camera
   * — and an assessment that treats a colleague's forwarded quartz vein as
   * first-hand would be a claim nobody can stand behind. Absent on records written
   * before the distinction existed, and absent means observed, which they were.
   */
  origin?: string;
  headingDeg: number | null;
  /**
   * The local file and, once uploaded, the remote path. Both travel: the device
   * copy is what a geologist reopens in the field with no network, and the remote
   * path is what the analysis actually reads.
   */
  photos: Array<{
    id: string;
    uri: string;
    capturedAt: number;
    /**
     * Travels because the server derives the R2 key's extension from it. Absent on
     * packages built before this field existed — those are JPEG, and the server
     * resolves a missing type to exactly that, so their keys are unchanged.
     */
    contentType?: string;
    remotePath: string | null;
  }>;
}

export interface EvidencePackage {
  version: number;
  /** Same id as the mission — one package per mission, for its whole life. */
  id: string;
  missionId: string;
  explorationSessionId: string | null;
  createdAt: number;

  /** ── What was investigated ─────────────────────────────────────────── */
  targetCell: string;
  targetCentre: { lat: number; lng: number };
  hotspot: MissionHotspot | null;
  commodity: string | null;
  /** The engine's score for the target when the mission was taken. */
  prospectivityScore: number;
  /** Why the engine offered it, structured — never a pre-built sentence. */
  targetReasons: TargetReason[];

  /** ── What the engine already knew ──────────────────────────────────── */
  /**
   * The engine's own numeric readings. Null on packages built before v2 — those
   * are read as NOT AVAILABLE, which for them is accurate: nothing measured them.
   */
  engineReadings: EngineReadings | null;
  geologyContext: string | null;
  terrainContext: string | null;
  structuralContext: string[];
  /**
   * Which of the thirteen evidence roles had anything to say here, and which did
   * not, and WHY not. Travels with the package because "no alteration reported"
   * and "alteration was never looked for" are different findings, and only this
   * tells them apart.
   */
  coverage: EvidenceCoverage | null;

  /** ── What the geologist did ────────────────────────────────────────── */
  observations: PackageObservation[];
  /** The traverse, as recorded. Empty when nothing was walked. */
  track: Array<{ lat: number; lng: number; at: number; accuracyM: number | null }>;
  arrivedAt: number | null;
  completedAt: number;

  /** ── Delivery ──────────────────────────────────────────────────────── */
  /** Set when the assessment comes back. Never written by the device. */
  analysis: PackageAnalysis | null;
  /**
   * Why an assessment did NOT come back, when the server said so.
   *
   * Distinct from `analysis: null`, which means "not yet". A mission waiting for
   * its photographs to upload and a mission whose analysis failed look identical
   * without this, and only one of them needs somebody to do something. The screen
   * used to fall back to `mission_closed` to decide, which is a different fact
   * entirely — a geologist can close a mission that is analysing perfectly well.
   */
  analysisError?: string | null;
  /**
   * What the server said last time, when it said nothing useful.
   *
   * NOT an error, and deliberately separate from `analysisError`: a package can be
   * legitimately waiting and still owe the geologist an explanation of what for.
   *
   * MEASURED, and the reason this exists. Three different answers — 409 waiting on
   * photographs, 403 not entitled, and 200 with no findings — were all handled by
   * `pullAnalysis` with "leave it alone and try again next pass", writing nothing
   * anywhere. Two packages sat on "AWAITING ANALYSIS" for hours while the server
   * was answering every sixty seconds, and the only way to learn which of the three
   * it was, was to open the Supabase dashboard. A field app must be able to say
   * what it is waiting for.
   */
  analysisNote?: string | null;
}

/**
 * The AI geologist's reading, when it returns.
 *
 * This is `MissionFindings` — the SAME structure the server produces, shared
 * rather than mirrored. It carries no prose in its findings, so the report is
 * rendered into Somali or English on demand with no model call and no possibility
 * of the two versions disagreeing.
 *
 * It has no probability field and no "confirmed" field. The type makes those
 * claims unrepresentable rather than relying on a prompt to discourage them.
 */
export type PackageAnalysis = MissionFindings;

export interface BuildPackageInput {
  mission: Mission;
  explorationSessionId: string | null;
  waypoints: readonly Waypoint[];
  track: Array<{ lat: number; lng: number; at: number; accuracyM: number | null }>;
  targetReasons: TargetReason[];
  geologyContext: string | null;
  terrainContext: string | null;
  structuralContext: string[];
  coverage: EvidenceCoverage | null;
  /** Supplied by the orchestrator from pack lookups. Null when no pack is loaded. */
  engineReadings?: EngineReadings | null;
  at: number;
}

/**
 * Assemble the package. Pure — no storage, no network, no clock of its own.
 *
 * Only the observations captured DURING this mission are included, matched by
 * session. Sweeping in every waypoint on the device would attach last week's
 * outcrop to today's target, and an assessment built on that would be wrong in a
 * way nobody could see.
 */
export function buildEvidencePackage(input: BuildPackageInput): EvidencePackage {
  const { mission } = input;
  // MISSION FIRST, session only as a fallback.
  //
  // `sessionId` and `trackId` identify a WALK, and a walk can hold several
  // missions — so matching on session swept every observation of the whole
  // traverse into each package, and the AI assessed one target against another
  // target's rock. A waypoint stamped with a mission is included only in that
  // mission's package.
  //
  // Records written before `missionId` existed, and observations captured between
  // missions, have none — those still fall back to the session-and-time rule, so
  // nothing already on a device is lost.
  const mine = input.waypoints.filter((w) => {
    if (w.deletedAt != null) return false;
    if (w.missionId != null) return w.missionId === mission.id;
    return w.capturedAt >= mission.startedAt &&
      (input.explorationSessionId == null ||
        w.sessionId === input.explorationSessionId ||
        w.trackId === input.explorationSessionId);
  });

  return {
    version: EVIDENCE_PACKAGE_VERSION,
    id: mission.id,
    missionId: mission.id,
    explorationSessionId: input.explorationSessionId,
    createdAt: input.at,

    targetCell: mission.cell,
    targetCentre: mission.centre,
    hotspot: mission.hotspot,
    commodity: mission.commodity,
    prospectivityScore: mission.score,
    targetReasons: input.targetReasons,

    engineReadings: input.engineReadings ?? null,
    geologyContext: input.geologyContext,
    terrainContext: input.terrainContext,
    structuralContext: input.structuralContext,
    coverage: input.coverage,

    observations: mine.map(toPackageObservation),
    track: input.track,
    arrivedAt: mission.arrivedAt,
    completedAt: input.at,

    analysis: null,
  };
}

function toPackageObservation(w: Waypoint): PackageObservation {
  return {
    id: w.id,
    type: w.type,
    notes: w.notes,
    capturedAt: w.capturedAt,
    position: w.position
      ? {
          lat: w.position.lat, lng: w.position.lng,
          accuracyM: w.position.accuracyM, altitudeM: w.position.altitudeM,
          ageMs: w.position.ageMs, provisional: w.position.provisional,
        }
      : null,
    positionQuality: qualityOf(w),
    origin: w.origin ?? "observed",
    headingDeg: w.heading?.trueHeading ?? null,
    photos: w.photos.map((p) => ({
      id: p.id, uri: p.uri, capturedAt: p.capturedAt,
      contentType: p.contentType, remotePath: p.remotePath,
    })),
  };
}

// Imported lazily rather than at module scope to keep this file free of the
// field layer's runtime — it is a pure assembler and is used in tests that load
// no sensors.
function qualityOf(w: Waypoint): string {
  const p = w.position;
  if (!p) return "none";
  if (p.ageMs > 60_000) return "stale";
  if (p.provisional || p.accuracyM == null) return "degraded";
  return p.accuracyM <= 25 ? "good" : "degraded";
}

/**
 * Is this package worth sending?
 *
 * A mission where nothing was observed still produced a real finding — "I went
 * there and there was nothing to record" is information — so an empty package is
 * legitimate and is kept. This only screens out the malformed.
 */
/**
 * Every package shape this build can still read.
 *
 * NOT just the current version — and the difference is a geologist's work.
 *
 * `isDeliverable` filters the store on load, so a version this list omits is
 * DISCARDED from the device the next time the app opens: finished sections,
 * photographs, a day's observations, gone, silently, because a field was added to
 * a type. Bumping EVIDENCE_PACKAGE_VERSION without adding the old number here is
 * exactly that mistake, and it is invisible until somebody's phone is empty.
 *
 * A version belongs here for as long as the app can make sense of it. v1 lacks
 * `engineReadings`; the server reads that as null, which for a v1 package is the
 * truth — nothing measured them. Nothing else differs.
 */
export const READABLE_PACKAGE_VERSIONS: readonly number[] = [1, 2];

export function isDeliverable(p: EvidencePackage): boolean {
  return READABLE_PACKAGE_VERSIONS.includes(p.version) &&
    p.missionId.length > 0 && p.targetCell.length > 0;
}

/** Photographs are the bulk of a package; count them before crossing a network. */
export function packageSize(p: EvidencePackage): { observations: number; photos: number; trackPoints: number } {
  return {
    observations: p.observations.length,
    photos: p.observations.reduce((n, o) => n + o.photos.length, 0),
    trackPoints: p.track.length,
  };
}

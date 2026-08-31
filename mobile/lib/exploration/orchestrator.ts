// ExplorationOrchestrator — the loop (Architecture §2, Stage E4).
//
// Owns workflow steps 1–8: start, orient, target, walk, arrive, capture,
// re-score, end. It COMPOSES OVER the frozen Phase 1 field session; it never
// duplicates GPS, heading or session logic (Invariant 5). There is exactly one
// sensor stack in the app and this is not it.
//
// Re-targeting is EVENT-DRIVEN, never per-fix (Invariant 7): a target that
// changes every ten metres is useless to someone walking.
import type { SessionSnapshot } from "../field/types";
import type { ExplorationTarget, Scored, TargetingEngine, TargetingOptions } from "../geo/targeting.ts";
import type { StructuredGeologicalEvidence } from "../field/structuredEvidenceTypes";
import type { EvidenceCoverage } from "../geo/evidenceCoverage";
import type { PackStore } from "../geo/packStore.ts";
import type { WaypointService } from "../field/waypointService";
import type {
  EvidenceOrigin, Waypoint, WaypointPosition, WaypointSample, WaypointType,
} from "../field/waypointTypes";
import { cellFor } from "../geo/h3.ts";
import { arrivalRadiusFor } from "../geo/fixQuality.ts";
import type { RegionalTarget } from "../geo/expedition.ts";
import type { GeoContext } from "../../../shared/geo-core/types.ts";
import { compassPoint } from "../../../shared/geo-core/geo/spatial.ts";
import {
  recordTargetSwitch,
  type TargetSwitchReason, type TargetSwitchTrigger,
} from "./targetSwitchLog";
import {
  advance, isMissionLive, isOnSite, newMission,
  type Mission, type MissionHotspot, type MissionState,
} from "./mission";
import { setCurrentMission } from "./currentExpedition";
import { markPhase } from "../diagnostics/jsStall";
import {
  buildEvidencePackage,
  type EngineReadings, type EvidencePackage, type PackageAnalysis,
} from "./evidencePackage";
import { nearestLineOfKind, terrainAt } from "../geo/featureInfo";
import type { PackageStore } from "./packageStore";
import type { Outbox } from "../sync/outbox";

export type ExplorationState =
  | "idle"
  | "orienting"        // first fix in; computing what is here
  | "guiding"          // a target is recommended; the user is walking
  | "noTarget"         // targeting finished and found nothing worth walking to
  | "awaitingEvidence" // target reached; evidence requested
  | "reasoning"        // re-scoring after new evidence
  | "summarising"
  | "ended";

/**
 * Whether `activeTarget` is a live recommendation or a decision to be honoured.
 *
 * FIELD-REPORTED BUG, and the reason this exists. A geologist driving to a target
 * was switched to a different one at 1.2 km, then back, then round again — 71
 * times in a reproduction, never once arriving. The destination was a value
 * recomputed from a ranking, so anything that reordered the ranking moved it.
 *
 *   none        no target
 *   suggested   the engine issued it and the traveller has not yet left the cell
 *               it was issued from. Still replaceable, deliberately: early fixes
 *               are poor and a better idea while you stand still is welcome.
 *   committed   the user picked it, OR they have left that cell and are visibly
 *               travelling. Ranking may no longer touch it, however the scores
 *               move. Released only by arriving, picking another, Recalculate,
 *               changing commodity, looking elsewhere up, or ending the session.
 */
export type TargetCommitment = "none" | "suggested" | "committed";

/** Why guidance is currently suspended, if it is. */
export type SuspendReason = "paused" | "no-fix" | "sensor-error";

export interface ExplorationSnapshot {
  state: ExplorationState;
  explorationSessionId: string | null;
  fieldSessionId: string | null;
  startedAt: number | null;
  endedAt: number | null;

  /** Where the geologist is, and what is under their feet (step 2). */
  currentCell: string | null;
  /**
   * The GPS fix itself, so the screen can show real coordinates and accuracy.
   *
   * `timestamp` and `altitudeM` are carried through unchanged from the receiver.
   * The screen grades the fix from them (see geo/fixQuality) rather than the
   * orchestrator doing it once: a fix does not get worse when it is read, it
   * gets worse as it AGES, and only something re-rendering on a clock can say so.
   */
  position: {
    lat: number; lng: number;
    accuracyM: number | null;
    altitudeM: number | null;
    timestamp: number;
  } | null;
  /**
   * A place the user asked to look at instead of where they are standing.
   *
   * Kept SEPARATE from `position` on purpose: the app must never present a
   * looked-up point as the user's location. When this is set the screen says so
   * and suppresses turn-by-turn guidance — you cannot be given a bearing from a
   * position you are not at (Invariant 4).
   */
  inspecting: { lat: number; lng: number } | null;
  /**
   * A point the user chose to walk to, entered by hand.
   *
   * Deliberately NOT an ExplorationTarget. A target carries a score, a band and
   * reasons — it is the engine's recommendation, and manufacturing those for a
   * coordinate somebody typed would put words in the engine's mouth. This is
   * plain navigation to a chosen point, presented as such, and it coexists with
   * whatever the engine is separately recommending.
   */
  destination: { lat: number; lng: number } | null;
  /** Metres and bearing to `destination`, from the last fix. */
  destinationDistanceM: number | null;
  destinationBearingDeg: number | null;
  /** Degrees to turn to face the destination; null without a heading. */
  destinationRelativeBearingDeg: number | null;
  /**
   * The pack record the destination came from, when it came from one.
   *
   * A regional target is neither of the two things above: not the engine's
   * recommendation for the next leg of a traverse, and not a coordinate somebody
   * typed. It is a REAL, MAPPED feature — an occurrence or a fault the pack
   * holds — that simply happens to be further away than one leg. Keeping it here
   * lets the screen name what it is and why it is on the list, without dressing
   * a map pin up as an assessment by forcing it into an ExplorationTarget.
   */
  selectedRegional: RegionalTarget | null;
  context: GeoContext | null;

  /** Ranked targets and the one being walked to (step 3). */
  targets: ExplorationTarget[];
  activeTarget: ExplorationTarget | null;
  /** Whether `activeTarget` may be replaced by a re-rank. See TargetCommitment. */
  targetCommitment: TargetCommitment;
  /**
   * The investigation in progress, from taking a target to closing it.
   *
   * Separate from `state`, which describes the SESSION — whether GPS is up,
   * whether a re-score is running. "How far through investigating this target am
   * I" is a different question, and conflating the two is what let arrival read
   * as the end of the job. Arriving is where the work starts: you have reached
   * five square kilometres of ground and looked at none of it.
   *
   * Null between missions. While it is non-null and not closed, no ranking may
   * hand out a different target.
   */
  mission: Mission | null;
  /**
   * A higher-scoring target than the one being travelled to, when there is one.
   *
   * REPORTED, NEVER ACTED ON. Swapping the destination because the ranking
   * changed its mind is the defect this field replaced; telling the traveller
   * that better ground exists, and letting them decide, is the point of it.
   * Null when the active target is still the best, or when nothing is held.
   */
  betterTargetAvailable: ExplorationTarget | null;
  /** Metres to the active target, from the last fix. */
  distanceToTargetM: number | null;
  /**
   * Where the phone is pointing, degrees from true north.
   *
   * Display only — it orients the map's direction cone. Guidance still uses
   * `relativeBearingDeg` below, computed from this exactly as before.
   */
  headingDeg: number | null;
  /**
   * How much the compass itself is to be trusted, straight from the platform.
   *
   * Reported, never smoothed. A phone beside a vehicle or a magnetite outcrop
   * will hand back a confident heading that is thirty degrees wrong, and the
   * only honest thing to do with that is say the compass wants calibrating.
   */
  headingAccuracy: number | null;
  headingNeedsCalibration: boolean;
  /**
   * Degrees the geologist must turn, relative to where they are facing.
   * Null when heading is unavailable — the bearing is still shown absolutely.
   */
  relativeBearingDeg: number | null;

  /** True when the current ground already beats every neighbour. */
  bestIsHere: boolean;
  /**
   * What the score under the geologist's feet was built from.
   *
   * Carried on the snapshot rather than recomputed by the screen, so the number
   * and its stated basis can never come from two different calculations. Null
   * before the first targeting run has completed.
   */
  coverage: EvidenceCoverage | null;
  /**
   * The commodity the assessment is conditioned on, by profile code, or null for
   * the universal engine.
   *
   * Null is the default and the validated one. Choosing a commodity narrows what
   * counts as relevant evidence; it does not unlock a separate model, and it never
   * turns a score into a probability of finding anything.
   */
  commodity: string | null;
  hasKnowledge: boolean;
  packProvenance: { packVersion: string; builtAt: string; ageDays: number; stale: boolean } | null;
  /** Why the pack is unusable, when it is. Null when it loaded or none is installed. */
  packProblem: string | null;

  /** Guidance is suspended (field session paused, no fix, sensor error). */
  suspendedBy: SuspendReason | null;
  /** Count of evidence captures fed back into the model this session. */
  evidenceCount: number;
  /** Cells re-targeted at, in order — the traverse's decision history. */
  visitedCells: string[];
  /** Targets actually reached this session, for the traverse summary. */
  targetsInvestigated: number;
}

/**
 * What FINISH SECTION needs that the orchestrator does not own.
 *
 * Everything here lives somewhere else in the app for a good reason — the
 * waypoints in their store, the track in the recorder, the landform in the map
 * readout — so it is handed in rather than duplicated.
 */
export interface FinishSectionInput {
  waypoints?: readonly Waypoint[];
  track?: Array<{ lat: number; lng: number; at: number; accuracyM: number | null }>;
  terrainContext?: string | null;
  /**
   * What the geologist entered on the User Geological Evidence form for this
   * mission, if anything. Lives in its own store (structuredEvidenceStore.ts),
   * same reason waypoints and the track are handed in rather than reached for.
   */
  structuredEvidence?: StructuredGeologicalEvidence | null;
}

/**
 * What the Add Waypoint form collects.
 *
 * `missionId` is deliberately ABSENT: it is derived inside `captureObservation`
 * from the live mission, so the UI has no way to supply, omit or contradict it.
 */
export interface CaptureObservationInput {
  type: WaypointType;
  /** The geologist's own words. An observation, never a fact — see the AI framing. */
  notes?: string;
  /** Present only when a sample was actually collected. */
  sample?: WaypointSample | null;
  /** Camera/library uris; copied into app-owned storage before the save. */
  photoUris?: string[];
  /**
   * A position somebody else supplied, with the origin that goes with it.
   *
   * Both or neither. A reported coordinate without the origin would file another
   * person's ground as an eyewitness record, which is the one thing this pair
   * exists to prevent; an origin without a coordinate would claim the geologist
   * was told about the very spot they are standing on.
   */
  position?: WaypointPosition | null;
  origin?: EvidenceOrigin;
}

export interface OrchestratorDeps {
  field: FieldSessionPort;
  targeting: TargetingEngine;
  packs: PackStore;
  now?: () => number;
  targetingOptions?: TargetingOptions;
  /** Capture side of the evidence loop (step 6). Optional so the loop is testable bare. */
  waypoints?: WaypointService;
  /**
   * The photo queue a capture hands its images to.
   *
   * The SAME queue Finish Section uses — one upload path, reached from two moments.
   * Optional so the loop is testable without a network stack.
   */
  photoUploads?: {
    enqueue(
      missionId: string,
      photos: ReadonlyArray<{ id: string; uri: string; contentType?: string }>,
    ): Promise<void>;
  };
  /**
   * The best point to stand inside a target area, when the evidence names one.
   *
   * Injected rather than imported so the orchestrator keeps no opinion about
   * scoring, and so the loop stays testable without a pack. Returning null is the
   * common and correct answer — see geo/hotspot.
   */
  findHotspot?: (cell: string, commodity: string | null) => Promise<MissionHotspot | null>;
  /**
   * Run something once the app has finished painting.
   *
   * ONLY the very first scoring run of a session uses this, and only because of
   * where that run lands. Measured on an SM-A165F:
   *
   *   UNRESPONSIVE 4145 ms IN: field.fix › explore.onFix › explore.retarget
   *
   * A cold start with an open expedition resumes the walk, the first GPS fix
   * arrives about a second later, and the whole scoring pass — pack materialised,
   * scene built, targets ranked — runs synchronously on the thread that has to
   * answer a tap. The geologist has the app open by then, and it does not respond.
   *
   * Deferring changes WHEN the first pass runs, never WHAT it computes: the same
   * fix, the same pack, the same ranking, a few hundred milliseconds later, with
   * the map already on screen. Every later run is unaffected — by then there is
   * nothing to be blocked from.
   *
   * Injected rather than imported so the orchestrator keeps no dependency on
   * React Native, and so tests stay synchronous. The default runs immediately,
   * which is exactly the old behaviour.
   */
  deferFirstRun?: (fn: () => void) => void;
  /**
   * Defer the (blocking) ranking WORK until the current interaction finishes, so a
   * button tap or gesture is never held while rank() runs — the same
   * InteractionManager.runAfterInteractions pattern map.buildScene already uses.
   * The RESULT is unchanged; only the moment it runs moves. Absent in tests, where
   * it runs inline (identical to the old synchronous behaviour).
   */
  deferRank?: (fn: () => void) => void;
  /** Where finished packages are written. Absent in tests that do not deliver. */
  packages?: PackageStore;
  /** The durable queue a package is handed to once written. */
  outbox?: Outbox;
}

/** The only thing this needs from Phase 1. FieldSessionController satisfies it. */
export interface FieldSessionPort {
  getSnapshot(): SessionSnapshot;
  subscribe(l: () => void): () => void;
  start(): void;
  stop(): void;
}

/** A walk being picked up again after the process died — same id, same clock. */
export interface ResumeExpedition {
  sessionId: string;
  startedAt: number;
}

/**
 * Arrival threshold, widened by how uncertain the fix is, so a ±40 m fix cannot
 * flap (§3.5).
 *
 * Delegates to geo/fixQuality rather than carrying its own formula. There was a
 * second copy here with a flat 50 m floor, which announced arrival while the
 * geologist was still half a minute's walk away on a fix good enough to do far
 * better. One rule, and it is the one that reads the fix.
 */
export { arrivalRadiusFor as arrivalRadiusM } from "../geo/fixQuality.ts";

/**
 * Signed turn from where you face to where you should go, in [-180, 180).
 * Negative is left, positive is right. An exact about-face reports -180; the
 * sign is arbitrary there because both turns are the same size.
 */
export function relativeBearing(target: number, heading: number): number {
  return ((((target - heading) % 360) + 540) % 360) - 180;
}

/**
 * Identity of a destination, for the promoted-once guard.
 *
 * Six decimals is about 0.1 m — finer than any receiver — so two keys differ only
 * when the geologist genuinely chose a different point, never because a float came
 * back from storage with a different last bit.
 */
export function destinationKey(p: { lat: number; lng: number }): string {
  return `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
}

type Listener = () => void;

export class ExplorationOrchestrator {
  private snap: ExplorationSnapshot = emptySnapshot();
  private listeners = new Set<Listener>();
  private unsubField: (() => void) | null = null;
  private seq = 0;
  private lastTargetedCell: string | null = null;
  /**
   * The cell a SUGGESTED target was issued from.
   *
   * Leaving it is what turns a suggestion into a commitment: it is the earliest
   * moment the system can honestly say the traveller has set off, and it needs no
   * speed, no timer and no threshold to decide.
   */
  private targetIssuedFrom: string | null = null;
  /** Guards against two hotspot searches for the same arrival. */
  private hotspotFor: string | null = null;
  /**
   * The destination already promoted to a target on arrival, as "lat,lng".
   *
   * Promotion is one async targeting call, and `updateGuidance` runs on every fix.
   * Without this the same point would be promoted every three seconds, and a point
   * the pack has nothing to say about — where promotion legitimately fails — would
   * be retried for as long as the geologist stood on it.
   */
  private promotedDestination: string | null = null;
  private retargeting = false;
  private inspect: { lat: number; lng: number } | null = null;
  /**
   * The ground the geology engine must reason about, when it is NOT where the
   * phone is standing — a reported observation's coordinate.
   *
   * Reuses the reported waypoint's own `position`; it is not a second coordinate
   * system. Null in the ordinary (observed) case, and then the engine reads the
   * live fix exactly as before. Set only while a reported investigation is the
   * active one, and cleared when it is finished or the mission closes. Navigation
   * never consults this — `updateGuidance` reads the live fix directly, so the
   * user is still guided from where they actually are to the reported site.
   */
  private evidenceAt: { lat: number; lng: number } | null = null;
  private cachedSnapshot: ExplorationSnapshot | null = null;
  /** Has any scoring pass run this session? Only the first one is deferred. */
  private hasScored = false;

  constructor(private readonly deps: OrchestratorDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  // ── Read side ─────────────────────────────────────────────────────────────
  /**
   * WHICH PACK IS LOADED IS NOT A RESULT OF TARGETING.
   *
   * It used to be treated as one. `packProvenance` and `packProblem` were written
   * in exactly one place — the success path of `retarget()` — so until a ranking
   * run completed they stayed at their `emptySnapshot()` defaults of null. The
   * field build showed what that means: Diagnostics read "Pack version: NOT
   * LOADED" while, three rows above, it printed that same pack's SHA256, named
   * the Macrostrat unit under the geologist's feet, and the map drew its geology,
   * faults and occurrences. All of those read the PACK STORE. Only this one read
   * a latch that targeting had not yet got round to setting.
   *
   * So it is derived here instead, from the store the map itself renders from.
   * Two sources of truth for one fact is the defect; there is now one.
   *
   * Derived, but still referentially stable — `provenance()` mints a new object
   * per call, and returning a fresh snapshot from every read would spin any
   * `useSyncExternalStore` above it. The snapshot is rebuilt only when the
   * VALUES change.
   */
  getSnapshot(): ExplorationSnapshot {
    const packProvenance = this.deps.packs.provenance();
    const packProblem = packProblemOf(this.deps.packs.getStatus());

    // Compared against the snapshot ITSELF rather than a separate latch:
    // start() replaces the whole snapshot with emptySnapshot(), which would
    // leave any side latch agreeing with a pack field that had just been reset
    // to null — the same class of bug one layer down.
    const held = this.snap.packProvenance;
    const moved =
      !held !== !packProvenance ||
      held?.packVersion !== packProvenance?.packVersion ||
      held?.ageDays !== packProvenance?.ageDays ||
      held?.stale !== packProvenance?.stale ||
      this.snap.packProblem !== packProblem;

    if (moved) {
      this.snap = { ...this.snap, packProvenance, packProblem };
      this.cachedSnapshot = null;
    }

    this.cachedSnapshot ??= { ...this.snap };
    return this.cachedSnapshot;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  // ── Step 1: start ─────────────────────────────────────────────────────────
  /**
   * Begin a walk — or RESUME one that a process kill interrupted.
   *
   * Resuming exists because the lease outlives the process and the orchestrator
   * does not. Android reclaims a backgrounded app overnight; on the next launch
   * the stored lease still says a walk is open while this object starts at
   * `idle`. Without a resume the two disagree: the app holds the auth gate open
   * for an expedition that is recording nothing, and — worse — `stop()` can
   * never run, so the lease is orphaned until its fourteen-day safety net.
   *
   * The walk keeps its ORIGINAL id and start time. A resumed traverse is the
   * same traverse: a new id would fork it, and a new start time would misreport
   * how long the geologist has been out.
   */
  start(resume?: ResumeExpedition): void {
    if (this.snap.state !== "idle" && this.snap.state !== "ended") return;
    const t = this.now;
    this.snap = {
      ...emptySnapshot(),
      state: "orienting",
      explorationSessionId: resume?.sessionId ?? `ex-${t.toString(36)}-${++this.seq}`,
      startedAt: resume?.startedAt ?? t,
    };
    this.lastTargetedCell = null;
    this.targetIssuedFrom = null;
    this.notify();

    // Phase 1 owns permissions, first fix and every error path.
    this.deps.field.start();
    this.unsubField ??= this.deps.field.subscribe(() => this.onFieldChange());
    this.onFieldChange();
  }

  /** Step 8: end the session. Phase 1 owns teardown. */
  stop(): void {
    if (this.snap.state === "idle" || this.snap.state === "ended") return;
    this.patch({ state: "summarising" });
    this.deps.field.stop();
    this.unsubField?.();
    this.unsubField = null;
    this.releaseTarget();
    this.patch({ state: "ended", endedAt: this.now, activeTarget: null });
  }

  /** Provider-unmount safety. */
  destroy(): void {
    if (this.snap.state !== "idle" && this.snap.state !== "ended") this.stop();
    this.unsubField?.();
    this.unsubField = null;
    this.listeners.clear();
  }

  /** Manual re-target (pull to refresh) — an explicit trigger, per §3.4. */
  refresh(): void {
    // Re-score, always. Move the destination, only if no mission is holding it.
    //
    // Before the mission layer this was the escape hatch from a committed target,
    // and for a bare suggestion it still is. Once an investigation is open the
    // target changes only three ways — finish it, close it, or pick another by
    // hand — so Recalculate here refreshes what is known about the ground without
    // quietly relocating the geologist.
    if (!isMissionLive(this.snap.mission?.state ?? "none")) this.releaseTarget();
    void this.retarget(true, "refresh");
  }

  /** Let go of the destination. Every caller is an explicit act, never a re-rank. */
  private releaseTarget(): void {
    this.targetIssuedFrom = null;
    if (this.snap.targetCommitment !== "none" || this.snap.betterTargetAvailable) {
      this.patch({ targetCommitment: "none", betterTargetAvailable: null });
    }
  }

  /**
   * Assess the ground for one commodity, or for none.
   *
   * `null` restores the universal engine, which is the validated default. The
   * targets are recomputed rather than re-labelled: conditioning changes which
   * evidence counts, so the ranking genuinely differs, and a stale list carrying
   * a new commodity's name would be the worst of both.
   */
  setCommodity(code: string | null): void {
    if (this.snap.commodity === code) return;
    this.releaseTarget();

    // THE MISSION'S COMMODITY FOLLOWS THE SNAPSHOT'S.
    //
    // `newMission` captures the commodity once, at creation. Changing it afterwards
    // used to update the snapshot and leave the mission behind — and the mission is
    // what `buildEvidencePackage` reads. So a geologist who selected GOLD produced a
    // package saying `commodity: null`, the AI assessed the wrong question, and the
    // report came back "assessed on geology alone" while the screen said GOLD.
    // Measured: mission.commodity=null, snapshot.commodity=gold.
    const mission = this.snap.mission && isMissionLive(this.snap.mission.state)
      ? { ...this.snap.mission, commodity: code }
      : this.snap.mission;

    // The hotspot was found FOR the old commodity, and `hotspotFor` is what stops a
    // second search for the same cell. Leaving it set meant the stale hotspot could
    // never be replaced — at exactly the point where the commodity matters most,
    // because a hotspot is the answer to "where in this area, for this commodity".
    this.hotspotFor = null;

    this.patch({ commodity: code, activeTarget: null, mission });
    this.lastTargetedCell = null;
    void this.retarget(true, "commodity");

    // Re-run the search if the geologist is already standing on the ground. Nothing
    // else will: `searchHotspot` fires on arrival, and arrival has already happened.
    if (mission && isOnSite(mission.state)) void this.searchHotspot(mission.cell);
  }

  /**
   * Take a target the USER named, at ANY distance.
   *
   * FIELD-REPORTED, and the reason this exists. The engine offered a target 1.5 km
   * off and there was no way to go anywhere else: `selectTarget` only accepted
   * cells already in the ranked list, and that list is `kRing(here, 3)` — about
   * 8 km at best. A hill a geologist could see beyond that was not a candidate, so
   * it could not be chosen. Refusing to route somewhere a geologist has decided to
   * go is not the app's decision to make.
   *
   * So: no ring, no distance cap, no minimum score. The engine's opinion of the
   * ground is reported on the target; it is not used as a gate. This is a
   * COMMITTED choice — the strongest form there is — so it survives every re-rank
   * exactly like a hand-picked one from the list.
   */
  async selectTargetAt(
    lat: number, lng: number, opts: { aimAtChosenPoint?: boolean } = {},
  ): Promise<boolean> {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
    const from = this.activePoint();
    if (!from) return false;

    const ranked = await this.deps.targeting.targetAt(from, { lat, lng }, {
      ...this.deps.targetingOptions,
      commodity: this.snap.commodity,
    });
    // Null means the cell has nothing to say about itself at all. Reported back so
    // the screen can say so, rather than the tap appearing to do nothing.
    if (!ranked) return false;

    // WHICH POINT IN THE CELL TO WALK TO.
    //
    // A target is a cell, and its `centre` is where guidance points — the honest
    // default when the engine picked the cell, because nothing inside it stands out
    // yet. It is the wrong answer for a point the geologist picked themselves: they
    // are standing on the spot they chose, and the cell centre can be most of a
    // kilometre away, so the app would greet their arrival by telling them to walk
    // 800 m to the middle of the hexagon.
    //
    // Only the guidance point moves. The cell, its score, its band and its reasons
    // are the ranking's, untouched — this says where to stand, not what the ground
    // is worth.
    const t = opts.aimAtChosenPoint ? { ...ranked, centre: { lat, lng } } : ranked;

    // Exactly the path a hand-picked target takes, so there is one commitment rule
    // rather than two. Offering the target list and the map as different kinds of
    // choice is how they would drift apart.
    this.targetIssuedFrom = null;
    this.hotspotFor = null;
    const at = cellFor(from.lat, from.lng);
    this.logSwitch("user-selected", from, at, this.snap.activeTarget, t, this.snap.targets);

    const open = this.snap.mission;
    const carried = open && isMissionLive(open.state) && open.cell !== t.cell
      ? advance(open, "mission_closed", this.now)
      : open;
    const mission = carried && isMissionLive(carried.state) && carried.cell === t.cell
      ? carried
      : newMission(`ms-${this.now.toString(36)}-${++this.seq}`, t.cell, t.centre, {
          commodity: this.snap.commodity, score: t.score, reportScore: t.reportScore, at: this.now,
        });

    this.patch({
      activeTarget: t, state: "guiding",
      targetCommitment: "committed", betterTargetAvailable: null,
      mission,
    });
    this.updateGuidance();
    return true;
  }

  /**
   * Look up a place the user is NOT standing at.
   *
   * Reads the same offline knowledge for an arbitrary point, so a geologist can
   * check ground before walking to it — or check somewhere they will never go.
   * It does not move the session: the GPS fix keeps updating underneath, and
   * `inspecting` marks the readout as a lookup rather than a position.
   */
  inspectAt(lat: number, lng: number): void {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return;
    this.inspect = { lat, lng };
    this.releaseTarget();
    this.patch({ inspecting: this.inspect, activeTarget: null });
    this.lastTargetedCell = null;
    void this.retarget(true, "inspect");
  }

  /** Back to the real position. */
  clearInspect(): void {
    if (!this.inspect) return;
    this.inspect = null;
    this.releaseTarget();
    this.patch({ inspecting: null, activeTarget: null });
    this.lastTargetedCell = null;
    void this.retarget(true, "inspect");
  }

  /**
   * Walk to a point the user entered by hand.
   *
   * Separate from `inspectAt`, which reads the geology somewhere without moving
   * the session. This one gives a real bearing and distance — and it takes them
   * from the GPS fix, never from an inspected point, because a direction from a
   * place you are not standing would send someone the wrong way.
   */
  navigateTo(lat: number, lng: number): void {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return;
    this.promotedDestination = null;
    this.patch({ destination: { lat, lng }, selectedRegional: null });
    this.updateGuidance();
  }

  /**
   * Walk — or drive — to a mapped feature the pack holds, at ANY distance.
   *
   * The engine's own targeting stops at one leg of a traverse, and that is
   * right: recommending a 94 km walk is not a recommendation. But refusing to
   * recommend was being rendered as "nothing to walk to here", which is a
   * different and false claim — the pack knew exactly where the nearest gold
   * occurrence was. This navigates to it and lets the screen say how far, how
   * long, and by what means, which is guidance rather than a dead end.
   */
  navigateToRegional(target: RegionalTarget): void {
    if (!Number.isFinite(target.lat) || !Number.isFinite(target.lng)) return;
    this.promotedDestination = null;
    this.patch({
      destination: { lat: target.lat, lng: target.lng },
      selectedRegional: target,
    });
    this.updateGuidance();
  }

  /** Stop navigating to the chosen point. */
  clearDestination(): void {
    if (!this.snap.destination) return;
    this.promotedDestination = null;
    this.patch({
      destination: null,
      destinationDistanceM: null,
      destinationBearingDeg: null,
      destinationRelativeBearingDeg: null,
      selectedRegional: null,
    });
  }

  /**
   * The point the engine is answering about.
   *
   * Priority: an inspected place (a map lookup), then reported evidence (a
   * coordinate somebody sent, which the phone is nowhere near), then the live
   * fix. The reported case is the fix for the Qardho/Borama bug — without it the
   * geology of a reported site was computed around the phone, hundreds of
   * kilometres away. For an ordinary OBSERVED observation `evidenceAt` is null
   * and this returns the live fix, unchanged.
   */
  private activePoint(): { lat: number; lng: number } | null {
    if (this.inspect) return this.inspect;
    if (this.evidenceAt) return this.evidenceAt;
    const f = this.deps.field.getSnapshot().lastFix;
    return f ? { lat: f.lat, lng: f.lng } : null;
  }

  /**
   * Open or move on the mission that goes with the current destination.
   *
   * Returns the mission unchanged when nothing should happen, so the caller can
   * put it straight into a patch.
   */
  private missionFor(
    active: ExplorationTarget | null,
    commitment: TargetCommitment,
  ): Mission | null {
    const m = this.snap.mission;
    // A closed mission is KEPT, not wiped. It is the record of what was just
    // finished, the package it produced is still in the store, and the screen has
    // to be able to say "mission closed, evidence queued" rather than showing
    // nothing at all. It is replaced only when a new one opens.
    if (active == null) return m;
    // A suggestion is not a mission. Only a decision opens one.
    if (commitment !== "committed") return m;
    if (m && isMissionLive(m.state)) {
      if (m.cell !== active.cell) return m;   // held target wins; see `locked`
      return m.state === "target_selected" ? advance(m, "navigating", this.now) : m;
    }
    return newMission(`ms-${this.now.toString(36)}-${++this.seq}`, active.cell, active.centre, {
      commodity: this.snap.commodity, score: active.score, reportScore: active.reportScore, at: this.now,
    });
  }

  /** Move the mission on, if the move is legal. One place, so the rules hold. */
  private advanceMission(to: MissionState): Mission | null {
    const m = this.snap.mission;
    if (!m) return null;
    const next = advance(m, to, this.now);
    if (next !== m) this.patch({ mission: next });
    return next;
  }

  /**
   * Look for the best place to stand inside the area just reached.
   *
   * Once per arrival, never per fix: it scores 49 points, which is about what one
   * ranking costs. Failure is silent and leaves `hotspot` null, which is also the
   * ordinary answer — most areas have no part that stands out, and the screen says
   * so rather than inventing a point.
   */
  private async searchHotspot(cell: string): Promise<void> {
    if (!this.deps.findHotspot || this.hotspotFor === cell) return;
    this.hotspotFor = cell;
    try {
      const hotspot = await this.deps.findHotspot(cell, this.snap.commodity);
      const m = this.snap.mission;
      if (m && m.cell === cell && isMissionLive(m.state)) {
        this.patch({ mission: { ...m, hotspot } });
      }
    } catch {
      // A hotspot is an enhancement. Losing it must not cost the arrival.
    }
  }

  /**
   * The geologist has started working the ground.
   *
   * Separate from arriving on purpose: reaching the area and beginning to record
   * are different moments, and a package that claims investigation began the
   * instant a vehicle crossed a hexagon boundary would be wrong about its own
   * timings.
   */
  beginInvestigation(): void {
    this.advanceMission("field_investigation");
  }

  /**
   * The evidence `score`/`reportScore` were actually built from, for the
   * mission's own cell.
   *
   * `activeTarget` usually already has it (`buildTarget()` sets `evidence` on
   * every target it returns) — but re-ranking keeps proposing targets for
   * OTHER cells while a mission is held open, so `activeTarget` can point
   * somewhere else by the time investigation finishes. When it does, this
   * scores the mission's own cell fresh via `targetAt()` — the SAME public
   * entry point `buildTarget()` is behind, not a second implementation of it —
   * rather than silently reporting no baseline for a mission that plainly has
   * one.
   */
  private async baselineEvidenceFor(m: Mission): Promise<readonly Scored[] | null> {
    const at = this.snap.activeTarget;
    if (at && at.cell === m.cell) return at.evidence;
    const t = await this.deps.targeting.targetAt(m.centre, m.centre, { commodity: m.commodity });
    return t?.evidence ?? null;
  }

  /**
   * FINISH SECTION — assemble the package and write it to the device.
   *
   * Nothing is sent here. The field has no network; that is the normal case, not
   * the exception, and a workflow that only completes online is one that loses a
   * day's work in a valley. The package goes to disk, then to the durable queue,
   * and the sync layer delivers it whenever a network next appears.
   */
  async finishSection(extra: FinishSectionInput = {}): Promise<EvidencePackage | null> {
    const m = this.snap.mission;
    if (!m || !isOnSite(m.state)) return null;

    const completed = advance(m, "section_completed", this.now);
    const baselineEvidence = await this.baselineEvidenceFor(completed);
    const pkg = buildEvidencePackage({
      mission: completed,
      explorationSessionId: this.snap.explorationSessionId,
      waypoints: extra.waypoints ?? [],
      track: extra.track ?? [],
      targetReasons: this.snap.activeTarget?.reasons ?? [],
      geologyContext: this.snap.context?.geology?.unit ?? null,
      baselineEvidence,
      structuredEvidence: extra.structuredEvidence ?? null,
      /**
       * The engine's numeric readings, from the pack it already has loaded.
       *
       * Read only — `terrainAt` and `nearestLineOfKind` are lookups over data
       * that is already in memory. Nothing is scored, no provider is run, and no
       * ranking is consulted. Without these the prompt received null for all four
       * and the model reported them as evidence NOBODY HAD LOOKED AT, when the
       * engine had measured every one before offering the target.
       */
      engineReadings: this.engineReadingsAt(),
      // Terrain and the traverse are passed IN. Neither is on the snapshot: the
      // landform reading lives in the map workspace's readout and the track in the
      // recorder, and reaching into either from here would put a second copy of
      // them in the system. A caller that has them supplies them; one that does
      // not gets null, which the package states plainly rather than guessing.
      terrainContext: extra.terrainContext ?? null,
      structuralContext: (this.snap.activeTarget?.reasons ?? [])
        .filter((r) => r.kind === "fault" || r.kind === "contact" || r.kind === "intersection")
        .map((r) => r.kind),
      coverage: this.snap.coverage,
      at: this.now,
    });

    // Disk BEFORE the queue. If the process dies between them the work still
    // exists and can be re-queued; a queue entry with no package behind it is a
    // promise the device cannot keep.
    await this.deps.packages?.save(pkg, this.deps.outbox);

    const queued = advance({ ...completed, packageId: pkg.id }, "waiting_for_upload", this.now);
    this.patch({ mission: queued, state: "reasoning" });
    // The reported section is filed; unpin the engine so anything scored next is
    // measured where the phone is, not at the site that was just reported.
    this.evidenceAt = null;
    return pkg;
  }

  /**
   * The assessment came back.
   *
   * The last state that was unreachable: nothing moved a mission into
   * `ai_analysis_complete`, so the workflow had a terminal step nobody could get
   * to. The findings are written to the package store first — a state saying the
   * analysis arrived, with no analysis behind it, would be worse than the state
   * never being reached at all.
   */
  async attachAnalysis(findings: PackageAnalysis): Promise<void> {
    const m = this.snap.mission;
    if (!m || !m.packageId) return;
    await this.deps.packages?.attachAnalysis(m.packageId, findings);
    this.advanceMission("ai_analysis_complete");
  }

  /**
   * What the pack measures about where the geologist is standing.
   *
   * Null throughout when there is no position or no pack — which the package then
   * states plainly. A null here means "not measured"; a null on ONE field means
   * "measured, nothing in range", and the prompt renders both as NOT AVAILABLE
   * because from the reader's side they are the same: no number to reason from.
   */
  private engineReadingsAt(): EngineReadings | null {
    // The reported-evidence coordinate when there is one, otherwise where the
    // phone is standing. Same rule as activePoint(): a reported site's readings
    // must be measured at the reported site, never at the device.
    const p = this.evidenceAt ?? this.snap.position;
    const data = this.deps.packs?.getData?.() ?? null;
    if (!p || !data) return null;
    const at = { lat: p.lat, lng: p.lng };
    const cell = terrainAt(data, at);
    return {
      elevationM: cell?.elevationM ?? null,
      faultDistanceM: nearestLineOfKind(data, at, "fault")?.distanceM ?? null,
      contactDistanceM: nearestLineOfKind(data, at, "contact")?.distanceM ?? null,
      // The DEM cell already carries this; recomputing it from the drainage lines
      // would be a second answer to a question the pack has already answered.
      drainageDistanceM: cell?.drainageDistM ?? null,
    };
  }

  /**
   * Close the mission. Only now may the engine recommend somewhere else.
   *
   * Reachable from every live state, deliberately. A geologist who has to leave
   * must be able to, and the package built before they left is still queued, still
   * uploaded and still analysed — abandoning the walk does not discard the work.
   */
  closeMission(): void {
    const m = this.snap.mission;
    if (!m || !isMissionLive(m.state)) return;
    // A reported investigation ends here: unpin the engine so the next
    // suggestion is scored where the phone actually is.
    this.evidenceAt = null;
    this.patch({ mission: advance(m, "mission_closed", this.now) });
    this.hotspotFor = null;
    this.releaseTarget();
    this.patch({ activeTarget: null, state: "reasoning" });
    this.lastTargetedCell = null;
    void this.retarget(true, "user-selected");
  }

  /**
   * Abandon a hand-picked target and return to the nearest suggestion.
   *
   * The geologist chose a FAR target by hand — a known occurrence, a fault, a
   * place they are sure of — and the app held it (that is the whole point of a
   * committed target). "Cancel" here undoes that choice: it drops the commitment
   * and re-ranks now so the ordinary NEAR recommendation comes straight back,
   * pointing to it again. It is not `closeMission` — nothing was investigated, so
   * nothing is filed; a chosen destination is simply let go. Same revert as
   * closeMission but never gated on a live mission, so it works whether the
   * choice had opened one yet or not.
   */
  cancelChosenTarget(): void {
    const m = this.snap.mission;
    if (m && isMissionLive(m.state)) {
      this.evidenceAt = null;
      this.patch({ mission: advance(m, "mission_closed", this.now) });
      this.hotspotFor = null;
    }
    this.releaseTarget();
    this.patch({ activeTarget: null, state: "reasoning" });
    this.lastTargetedCell = null;
    void this.retarget(true, "user-selected");
  }

  /**
   * Choose a different target from the ranked list.
   *
   * The strongest form of commitment there is: it survives every re-rank until the
   * user arrives, asks again, or ends the walk.
   */
  selectTarget(cell: string): void {
    const t = this.snap.targets.find((x) => x.cell === cell);
    if (!t) return;
    const from = this.activePoint();
    const at = from ? cellFor(from.lat, from.lng) : null;
    if (from && at) this.logSwitch("user-selected", from, at, this.snap.activeTarget, t, this.snap.targets);
    this.targetIssuedFrom = null;
    this.hotspotFor = null;

    // Choosing a target OPENS a mission — this is TARGET_SELECTED. Picking a
    // different one while an investigation is open closes the old mission rather
    // than abandoning it silently: whatever package it produced is still queued
    // and still analysed, and the geologist keeps the record of having been there.
    const open = this.snap.mission;
    const carried = open && isMissionLive(open.state) && open.cell !== t.cell
      ? advance(open, "mission_closed", this.now)
      : open;
    const mission = carried && isMissionLive(carried.state) && carried.cell === t.cell
      ? carried
      : newMission(`ms-${this.now.toString(36)}-${++this.seq}`, t.cell, t.centre, {
          commodity: this.snap.commodity, score: t.score, reportScore: t.reportScore, at: this.now,
        });

    this.patch({
      activeTarget: t, state: "guiding",
      targetCommitment: "committed", betterTargetAvailable: null,
      mission,
    });
    this.updateGuidance();
  }

  /**
   * Step 6: record what the geologist is looking at, then step 7: re-score.
   *
   * The capture goes through the existing WaypointService, so position, heading
   * and photos are handled exactly as they are everywhere else — this does not
   * invent a second kind of observation. The re-score is immediate and offline;
   * that is what makes the app an assistant rather than a map.
   */
  async captureObservation(input: CaptureObservationInput): Promise<Waypoint | null> {
    if (this.snap.state === "idle" || this.snap.state === "ended") return null;
    const trackId = this.snap.explorationSessionId;

    // WHERE THE GEOLOGY IS ASSESSED, and it is NOT always where the phone is.
    //
    // A reported observation carries a coordinate somebody sent — the ground to
    // assess may be hundreds of kilometres from the device (Borama, while the
    // phone is in Qardho). So the investigation is opened ON THAT GROUND, through
    // the same committed-target path a hand-picked map target takes, and the
    // engine is pinned to it via `evidenceAt`. Then the mission's cell, centre
    // and prospectivity score, the fault/drainage/elevation readings and the
    // whole geology context are all about the reported site.
    //
    // Live GPS is untouched: navigation still runs from the fix (updateGuidance),
    // and an OBSERVED capture clears the pin and keeps the existing behaviour —
    // the phone's position IS the evidence location, exactly as before.
    if (input.origin === "reported" && input.position) {
      await this.selectTargetAt(input.position.lat, input.position.lng, { aimAtChosenPoint: true });
      this.evidenceAt = { lat: input.position.lat, lng: input.position.lng };
    } else {
      this.evidenceAt = null;
    }

    // THE UI NEVER SUPPLIES THIS. It is derived here from the live mission, so a
    // form cannot get it wrong and cannot step around it. Null outside a mission,
    // which is a legitimate state — a geologist records things between missions too.
    const missionId = this.snap.mission && isMissionLive(this.snap.mission.state)
      ? this.snap.mission.id
      : null;

    const result = await this.deps.waypoints?.capture({
      type: input.type,
      notes: input.notes,
      sample: input.sample,
      photoUris: input.photoUris,
      position: input.position,
      origin: input.origin,
      trackId,
      missionId,
    });

    // PHOTOS JOIN THE QUEUE NOW, not at Finish Section.
    //
    // The bytes are immutable the moment the shutter closes, so there is nothing to
    // wait for — and waiting meant a geologist who photographed a vein and did not
    // finish the section that day had nothing uploaded at all. The upload itself is
    // still the sync layer's problem and still happens only when a network exists;
    // this only puts the work on the queue.
    //
    // Outside a mission there is no key namespace to upload into
    // (missions/{missionId}/photos/...), so those wait for a mission. That is the
    // honest state rather than an invented prefix.
    const wp = result?.waypoint ?? null;
    if (wp && missionId && wp.photos.length > 0) {
      await this.deps.photoUploads?.enqueue(
        missionId,
        // The photograph's own type, not a constant repeated at the call site: the
        // key R2 stores it under is derived from this, so guessing here would put
        // the object somewhere the verification pass never looks.
        wp.photos.map((p) => ({ id: p.id, uri: p.uri, contentType: p.contentType })),
      );
    }

    // REPORTED EVIDENCE IS AN INVESTIGATION BEGINNING.
    //
    // The mission lifecycle is gated on physically arriving: `arrived_at_target_area`
    // is only ever reached from the arrival branch, so START INVESTIGATION, FINISH
    // SECTION and CLOSE all appear only to somebody standing on the ground. For a
    // target six hundred kilometres away — a colleague's coordinate and their
    // photographs — none of the three could ever be reached, and the mission sat in
    // `target_selected` for ever with a full set of evidence attached to it.
    //
    // Filing somebody else's observation against a target IS the work starting on
    // it, so the mission is advanced here rather than waiting for a walk that is not
    // going to happen. The transition table already permits it
    // (`target_selected -> arrived_at_target_area`), which is the same allowance
    // made for a geologist who was already standing in the cell they picked.
    //
    // Nothing changes for the walking flow: there, arrival has already advanced the
    // mission before any observation can be recorded, and `advance` returns the
    // mission untouched when the transition is not a legal one.
    if (wp && missionId && input.origin === "reported") {
      this.advanceMission("arrived_at_target_area");
    }

    await this.recordEvidence();
    return wp;
  }

  /**
   * Step 7 on its own: re-score from whatever evidence now exists. Used when
   * evidence was captured elsewhere (a scan, a waypoint from another screen).
   */
  async recordEvidence(): Promise<void> {
    if (this.snap.state === "idle" || this.snap.state === "ended") return;
    this.patch({ state: "reasoning", evidenceCount: this.snap.evidenceCount + 1 });
    await this.retarget(true, "evidence");
  }

  // ── Field session bridge ──────────────────────────────────────────────────
  private onFieldChange(): void {
    // Every GPS fix comes through here. If the thread is being held anywhere on
    // this path the receiver's updates queue behind it, and the app reports the
    // position as STALE — "703 seconds, no new position" standing outdoors under
    // a clear sky was the field report that connected the two.
    const done = markPhase("explore.onFix");
    try {
      this.onFieldChangeInner();
    } finally {
      done();
    }
  }

  private onFieldChangeInner(): void {
    const f = this.deps.field.getSnapshot();
    if (this.snap.state === "idle" || this.snap.state === "ended") return;

    const suspendedBy = suspendReasonFor(f);
    if (suspendedBy !== this.snap.suspendedBy) this.patch({ suspendedBy, fieldSessionId: f.sessionId });

    // Guidance suspends and resumes WITH the field session (§2.1).
    if (suspendedBy) { this.updateGuidance(); return; }

    const fix = f.lastFix;
    if (!fix) return;

    // Always publish the real fix, even while inspecting elsewhere: the user
    // should be able to see where they actually are at all times.
    this.patch({
      position: {
        lat: fix.lat, lng: fix.lng,
        accuracyM: fix.accuracy,
        altitudeM: fix.altitude,
        timestamp: fix.timestamp,
      },
    });

    // While inspecting, GPS movement must not silently re-target to the user's
    // own position — that would swap the answer under them without a word.
    if (this.inspect) return;

    const cell = cellFor(fix.lat, fix.lng);
    if (cell !== this.snap.currentCell) this.patch({ currentCell: cell });

    // Arrival is evaluated BEFORE re-targeting, and this ordering is load-bearing.
    // Reaching a target means entering its cell, which is also the re-target
    // trigger — so checking the cell first would consume the arrival and hand
    // out a new target instead of asking for the evidence the walk was for.
    this.updateGuidance();
    if (this.snap.state === "awaitingEvidence") return;

    // A REPORTED investigation pins the engine to the evidence coordinate, which
    // the phone is nowhere near. The cell-change trigger below compares the fix's
    // cell (where the phone is) against `lastTargetedCell` (which retarget set to
    // the reported cell) — they never match, so without this guard retarget fires
    // on EVERY fix and `targeting.rank` pegs the JS thread ~2.8 s at a time. The
    // fix location does not move, so there is nothing to re-rank; the real
    // position was published above and navigation was just updated from it. Same
    // shape as the `inspect` guard higher up.
    if (this.evidenceAt) return;

    // Re-target only on a CELL change, never on every fix (Invariant 7).
    if (cell !== this.lastTargetedCell) {
      // The FIRST pass of a session waits for the first frame; see deferFirstRun.
      // Marked before the deferral, not inside it, so a second fix arriving in the
      // meantime cannot queue a second first-run.
      if (!this.hasScored && this.deps.deferFirstRun) {
        this.hasScored = true;
        this.deps.deferFirstRun(() => void this.retarget(false, "gps-cell-change"));
      } else {
        this.hasScored = true;
        void this.retarget(false, "gps-cell-change");
      }
    }
  }

  /**
   * Record what happened to the destination, whether or not it moved.
   *
   * Diagnosis only — it changes no behaviour. It exists because a switch used to
   * leave no evidence anywhere, so the field report could not be checked against
   * the code.
   */
  private logSwitch(
    trigger: TargetSwitchTrigger,
    from: { lat: number; lng: number },
    fromCell: string,
    old: ExplorationTarget | null,
    next: ExplorationTarget | null,
    ranked: readonly ExplorationTarget[],
  ): void {
    const dist = (t: ExplorationTarget | null) =>
      t ? haversine(from.lat, from.lng, t.centre.lat, t.centre.lng) : null;
    let reason: TargetSwitchReason;
    if (old == null) reason = next == null ? "no-targets" : "first-target";
    else if (next == null) reason = "no-targets";
    else if (next.cell === old.cell) reason = "kept";
    // The order matters: being the cell the traveller just entered is WHY it left
    // the ranking, so reporting "dropped" here would name the symptom.
    else if (old.cell === fromCell) reason = "self-excluded-current-cell";
    else reason = "dropped-from-ranking";
    recordTargetSwitch({
      at: this.now, trigger, reason,
      oldTarget: old?.cell ?? null, newTarget: next?.cell ?? null,
      distanceOldM: dist(old), distanceNewM: dist(next),
      fromCell, ranked: ranked.map((t) => t.cell),
    });
  }

  private async retarget(force: boolean, trigger: TargetSwitchTrigger = "gps-cell-change"): Promise<void> {
    // The scoring run: the most expensive thing this class does, and the one most
    // likely to be holding the thread when a fix cannot get in. So it is DEFERRED
    // past the current interaction (a button tap, a gesture) exactly like
    // map.buildScene — the same ranking, the same result, run a beat later so the
    // tap is never held. Inline when no deferral is injected (tests).
    await this.runDeferredRank(async () => {
      const scored = markPhase("explore.retarget");
      try {
        await this.retargetInner(force, trigger);
      } finally {
        scored();
      }
    });
  }

  /**
   * Run the ranking work after the current interaction settles.
   *
   * Wraps deps.deferRank (InteractionManager.runAfterInteractions in the app) in a
   * promise so awaiting callers still see completion — the WORK moves off the tap,
   * the RESULT is identical. With no deferral injected it runs inline, which is
   * byte-for-byte the old synchronous path the tests already cover.
   */
  private runDeferredRank(work: () => Promise<void>): Promise<void> {
    const defer = this.deps.deferRank;
    if (!defer) return work();
    return new Promise<void>((resolve, reject) => {
      defer(() => { work().then(resolve, reject); });
    });
  }

  private async retargetInner(force: boolean, trigger: TargetSwitchTrigger = "gps-cell-change"): Promise<void> {
    const point = this.activePoint();
    if (!point) return;
    if (this.retargeting && !force) return;
    this.retargeting = true;

    const cell = cellFor(point.lat, point.lng);
    try {
      const result = await this.deps.targeting.rank(point.lat, point.lng, {
        ...this.deps.targetingOptions,
        commodity: this.snap.commodity,
      });
      this.lastTargetedCell = cell;

      const visited = this.snap.visitedCells.includes(cell)
        ? this.snap.visitedCells
        : [...this.snap.visitedCells, cell];

      // A DESTINATION IS NOT A RANKING OUTPUT.
      //
      // It used to be: the old target survived only if its cell was still in the
      // top three of a ranking recentred on wherever the traveller had reached.
      // Two things evicted it without its own score changing at all — `rank()`
      // drops the cell you are standing in, and the sort's distance tie-break is
      // measured from you, so with `limit: 3` a target could be pushed out by
      // cells that had merely come closer. Both are why the app ping-ponged.
      const prev = this.snap.activeTarget;
      // Leaving the cell a suggestion came from IS setting off.
      const travelling = prev != null && this.targetIssuedFrom != null &&
        this.targetIssuedFrom !== cell;
      // A LIVE MISSION IS THE OUTER LOCK, and it outlasts the walk.
      //
      // TargetCommitment protects the destination while there is still navigation
      // to protect. Once the geologist is standing in the target area there is
      // none — and that is exactly when they are least able to notice the app
      // quietly deciding they should be somewhere else. The mission holds the
      // target from the moment it is taken until it is closed.
      const locked = prev != null &&
        (isMissionLive(this.snap.mission?.state ?? "none") ||
          this.snap.targetCommitment === "committed" || travelling);

      // Refresh the held target's own figures when the new ranking still carries
      // it; keep the stored one when it does not. A cell is scored at its own
      // centre, so holding it does not make its score stale — only its bearing and
      // distance move, and updateGuidance derives both from the live fix.
      const stillRanked = prev
        ? result.targets.find((t) => t.cell === prev.cell) ?? null
        : null;
      const active = locked
        ? stillRanked ?? prev
        : stillRanked ?? result.targets[0] ?? null;

      // Only a replaceable suggestion records where it was issued from.
      if (!locked) this.targetIssuedFrom = active ? cell : null;
      const commitment: TargetCommitment =
        active == null ? "none" : locked ? "committed" : "suggested";

      // Better ground is news, not an instruction.
      const best = result.targets[0] ?? null;
      const better = active && best && best.cell !== active.cell && best.score > active.score
        ? best
        : null;

      this.logSwitch(trigger, point, cell, prev, active, result.targets);

      // Taking a target opens a mission; moving after that is navigating. Both are
      // derived from what already happened rather than from a button, because the
      // geologist in the field pressed nothing — they simply drove off.
      const mission = this.missionFor(active, commitment);

      this.patch({
        state: active ? "guiding" : "noTarget",
        currentCell: cell,
        context: result.current.context,
        targets: result.targets,
        activeTarget: active,
        targetCommitment: commitment,
        betterTargetAvailable: better,
        mission,
        bestIsHere: result.bestIsHere,
        // The basis of the CURRENT cell's score. An active target carries its own
        // on `activeTarget.coverage`.
        coverage: result.current.coverage,
        hasKnowledge: result.hasKnowledge,
        // packProvenance / packProblem are NOT set here. They are derived in
        // getSnapshot() from the pack store, because writing them only on this
        // path is what made Diagnostics claim no pack while the map drew one.
        visitedCells: visited,
      });
      this.updateGuidance();
    } finally {
      this.retargeting = false;
    }
  }

  /** Steps 4–5: distance, turn, and arrival — recomputed on every fix (cheap). */
  private updateGuidance(): void {
    const f = this.deps.field.getSnapshot();
    const fix = f.lastFix;
    const target = this.snap.activeTarget;

    const headingDeg = f.lastHeading?.trueHeading ?? null;
    const headingAccuracy = f.lastHeading?.accuracy ?? null;
    const headingNeedsCalibration = f.lastHeading?.needsCalibration ?? false;
    if (
      headingDeg !== this.snap.headingDeg ||
      headingAccuracy !== this.snap.headingAccuracy ||
      headingNeedsCalibration !== this.snap.headingNeedsCalibration
    ) {
      this.patch({ headingDeg, headingAccuracy, headingNeedsCalibration });
    }

    // A chosen destination is navigation, not a recommendation, so it is
    // computed first and independently: it must keep working while the user is
    // looking somewhere else up, and while the engine has nothing to recommend.
    // It is always measured from the GPS fix — never from an inspected point.
    if (this.snap.destination) {
      const dest = this.snap.destination;
      const headingNow = f.lastHeading?.trueHeading;
      const b = fix ? bearingTo(fix.lat, fix.lng, dest.lat, dest.lng) : null;
      const toDestM = fix ? haversine(fix.lat, fix.lng, dest.lat, dest.lng) : null;
      this.patch({
        destinationDistanceM: toDestM,
        destinationBearingDeg: b,
        destinationRelativeBearingDeg:
          b == null || headingNow == null ? null : relativeBearing(b, headingNow),
      });

      // GETTING THERE IS WHAT MAKES IT A PLACE.
      //
      // A destination used to be navigation and nothing more: the pill counted down
      // to 2 m and then said nothing, because arrival is judged on `activeTarget`
      // and a destination is not one. No arrival meant no mission, so the waypoints
      // and photographs taken there were filed with `missionId: null`, no evidence
      // package was ever built, and "Exploration Reports" stayed empty after a day
      // in the field. Two waypoints and nine photographs, and nothing to read.
      //
      // Travelling is still plain navigation — pointing at a lead 184 km away must
      // not open a mission on it. Standing on it is different, and it is the moment
      // the geologist wants to record what is there. So the destination is promoted
      // then, and only then, down the same path as a hand-picked target: one
      // commitment rule, one arrival rule, one report.
      // Not while standing on the ground the open mission is already about: the
      // geologist walked back to their own target, and re-opening it would close
      // and re-create the mission underneath the evidence they are recording. Any
      // OTHER place counts, even if they never filed the last one — deciding there
      // is nothing here and moving on is a normal morning, and the walk that
      // follows must not be silently demoted to sightseeing.
      const open = this.snap.mission;
      const sameGround = open != null && isMissionLive(open.state) &&
        cellFor(dest.lat, dest.lng) === open.cell;
      if (
        fix && toDestM != null &&
        toDestM <= arrivalRadiusFor(fix.accuracy) &&
        !sameGround &&
        !this.snap.suspendedBy &&
        this.promotedDestination !== destinationKey(dest)
      ) {
        this.promotedDestination = destinationKey(dest);
        void this.selectTargetAt(dest.lat, dest.lng, { aimAtChosenPoint: true }).then((taken) => {
          // The destination has become the target. Leaving it set would put a second
          // arrow on the screen pointing at the ground underfoot.
          if (taken) this.clearDestination();
        });
      }
    }

    // Inspecting somewhere else: show what is there, but no distance, no turn
    // and no arrival. Those only mean something from where you actually stand.
    if (this.inspect) {
      this.patch({ distanceToTargetM: null, relativeBearingDeg: null });
      return;
    }
    if (!fix || !target) {
      this.patch({ distanceToTargetM: null, relativeBearingDeg: null });
      return;
    }

    // Inside the area, guidance switches from the cell to the point worth
    // standing on — the hexagon is 2.4 km across, and "you have arrived" at its
    // edge leaves a morning's walking undecided. Falls back to the centre when no
    // part of the area stands out, which is the usual answer.
    const m = this.snap.mission;
    const aim = m && m.hotspot && isOnSite(m.state)
      ? { lat: m.hotspot.lat, lng: m.hotspot.lng }
      : target.centre;

    const distanceToTargetM = haversine(fix.lat, fix.lng, aim.lat, aim.lng);
    const heading = f.lastHeading?.trueHeading;

    // BEARING COMES FROM WHERE THE TRAVELLER IS, not from where they were when the
    // ranking ran. It used to be `target.bearingDeg`, refreshed only as a side
    // effect of rebuilding the target on every cell change — and a held target is
    // never rebuilt, so without this the arrow would point along a course
    // kilometres out of date.
    const bearingNow = bearingTo(fix.lat, fix.lng, aim.lat, aim.lng);
    const relativeBearingDeg = heading == null ? null : relativeBearing(bearingNow, heading);
    const drifted = Math.abs(((bearingNow - target.bearingDeg + 540) % 360) - 180) >= 1;

    // ARRIVAL IS MEASURED IN METRES, TO THE POINT THE SCREEN IS POINTING AT.
    //
    // The history matters, because the obvious reading of this code is that it was
    // always wrong, and it was not.
    //
    // A target is a CELL, ~5 km2 of ground. `rank()` drops the cell you are standing
    // in from its candidates, because you are already there. Arrival used to be
    // 25-150 m from the centre — and at H3 resolution 7 you enter a cell up to
    // ~1.2 km out. For that whole 1.2 km the two halves disagreed: the ranking said
    // "you are here, this is not a target" while guidance said "you have not
    // arrived". The target was discarded and another issued, over and over. A driver
    // alternated between two cells 71 times and never arrived once. The fix then was
    // to call entering the cell arriving, which ended the ping-pong.
    //
    // It also made the app lie. Measured in the field on an SM-A165F: "You reached
    // the target" on screen at the same moment as "Target: 1.1 km east" and
    // "Continue east — 1.1 km to the target", and again at 667 m. The receiver was
    // good to +-9 m, so the metric radius was 25 m; it was cell membership firing,
    // 44 times further out than the radius it was standing in for. Worse, arrival
    // spends the commitment (below), so the next re-rank was free to issue somewhere
    // else — a geologist walking to their first target was told they had reached it
    // and sent to another.
    //
    // The ping-pong does not come back, because the thing that actually holds the
    // target is not this test. `locked` in the re-rank holds it whenever a mission
    // is live, the commitment is taken, or the traveller has left the cell the
    // suggestion was issued from — all true from the moment they set off. The
    // ranking may drop the target; `active = stillRanked ?? prev` keeps it anyway.
    //
    // So arrival is now what the word means: close enough to the point the arrow is
    // pointing at to be standing on the ground it describes. `distanceToTargetM` is
    // the number already on the screen, so the sentence and the figure can no longer
    // contradict each other — there is only one of them.
    const arrived =
      distanceToTargetM <= arrivalRadiusFor(fix.accuracy) &&
      this.snap.state === "guiding" &&
      !this.snap.suspendedBy;

    if (arrived) this.targetIssuedFrom = null;

    this.patch({
      distanceToTargetM,
      relativeBearingDeg,
      ...(drifted
        ? {
            activeTarget: {
              ...target,
              bearingDeg: bearingNow,
              compass: compassPoint(bearingNow),
              distanceM: distanceToTargetM,
            },
          }
        : {}),
      ...(arrived
        ? {
            state: "awaitingEvidence" as ExplorationState,
            targetsInvestigated: this.snap.targetsInvestigated + 1,
            // The walk is done, so the commitment is spent. The MISSION is not —
            // it is only now beginning the part it exists for.
            targetCommitment: "none" as TargetCommitment,
            betterTargetAvailable: null,
          }
        : {}),
    });

    // ARRIVING IS THE START OF THE WORK, NOT THE END OF IT.
    //
    // The mission moves to "reached the area" and the hotspot search begins. What
    // has been reached is five square kilometres of ground; nothing on it has been
    // looked at yet. Treating arrival as completion is what this whole layer
    // exists to prevent.
    if (arrived && this.snap.mission && isMissionLive(this.snap.mission.state)) {
      const m = this.advanceMission("arrived_at_target_area");
      if (m) void this.searchHotspot(m.cell);
    }
  }

  // ── Plumbing ──────────────────────────────────────────────────────────────
  private patch(p: Partial<ExplorationSnapshot>): void {
    this.snap = { ...this.snap, ...p };
    // Publish the running mission wherever the mission changes, so the capture
    // screen — which sits on the ROOT stack and cannot read this context — can
    // attribute a sample to the mission it was taken on. A walk can contain
    // several missions, so the session id is not a substitute: that was the
    // defect that once attached one target's rock to another target's package.
    if ("mission" in p) {
      const m = this.snap.mission;
      setCurrentMission(m && isMissionLive(m.state) ? m.id : null);
    }
    this.notify();
  }

  private notify(): void {
    this.cachedSnapshot = null;
    for (const l of this.listeners) l();
  }
}

/** Local copy so the orchestrator does not import the pack layer for one formula. */
function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial great-circle bearing, degrees clockwise from true north. */
function bearingTo(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dl = toRad(lng2 - lng1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function suspendReasonFor(f: SessionSnapshot): SuspendReason | null {
  const s = f.machine.state;
  if (s === "error") return "sensor-error";
  if (s === "paused") return "paused";
  if (!f.lastFix) return "no-fix";
  return null;
}

/** A refused pack must say what is wrong with it; silence looks like absence. */
function packProblemOf(status: { state: string; reason?: string }): string | null {
  return status.state === "refused" ? (status.reason ?? "Pack refused") : null;
}

function emptySnapshot(): ExplorationSnapshot {
  return {
    state: "idle",
    explorationSessionId: null,
    fieldSessionId: null,
    startedAt: null,
    endedAt: null,
    currentCell: null,
    position: null,
    destination: null,
    destinationDistanceM: null,
    destinationBearingDeg: null,
    destinationRelativeBearingDeg: null,
    selectedRegional: null,
    inspecting: null,
    context: null,
    targets: [],
    activeTarget: null,
    targetCommitment: "none",
    betterTargetAvailable: null,
    mission: null,
    distanceToTargetM: null,
    headingDeg: null,
    headingAccuracy: null,
    headingNeedsCalibration: false,
    relativeBearingDeg: null,
    bestIsHere: false,
    coverage: null,
    commodity: null,
    hasKnowledge: false,
    packProvenance: null,
    packProblem: null,
    suspendedBy: null,
    evidenceCount: 0,
    visitedCells: [],
    targetsInvestigated: 0,
  };
}






















































































































































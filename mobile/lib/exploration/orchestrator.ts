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
import type { ExplorationTarget, TargetingEngine, TargetingOptions } from "../geo/targeting.ts";
import type { PackStore } from "../geo/packStore.ts";
import type { WaypointService } from "../field/waypointService";
import type { WaypointType } from "../field/waypointTypes";
import { cellFor } from "../geo/h3.ts";
import type { GeoContext } from "../../../shared/geo-core/types.ts";

export type ExplorationState =
  | "idle"
  | "orienting"        // first fix in; computing what is here
  | "guiding"          // a target is recommended; the user is walking
  | "awaitingEvidence" // target reached; evidence requested
  | "reasoning"        // re-scoring after new evidence
  | "summarising"
  | "ended";

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
  /** The GPS fix itself, so the screen can show real coordinates and accuracy. */
  position: { lat: number; lng: number; accuracyM: number | null } | null;
  /**
   * A place the user asked to look at instead of where they are standing.
   *
   * Kept SEPARATE from `position` on purpose: the app must never present a
   * looked-up point as the user's location. When this is set the screen says so
   * and suppresses turn-by-turn guidance — you cannot be given a bearing from a
   * position you are not at (Invariant 4).
   */
  inspecting: { lat: number; lng: number } | null;
  context: GeoContext | null;

  /** Ranked targets and the one being walked to (step 3). */
  targets: ExplorationTarget[];
  activeTarget: ExplorationTarget | null;
  /** Metres to the active target, from the last fix. */
  distanceToTargetM: number | null;
  /**
   * Degrees the geologist must turn, relative to where they are facing.
   * Null when heading is unavailable — the bearing is still shown absolutely.
   */
  relativeBearingDeg: number | null;

  /** True when the current ground already beats every neighbour. */
  bestIsHere: boolean;
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
}

export interface OrchestratorDeps {
  field: FieldSessionPort;
  targeting: TargetingEngine;
  packs: PackStore;
  now?: () => number;
  targetingOptions?: TargetingOptions;
  /** Capture side of the evidence loop (step 6). Optional so the loop is testable bare. */
  waypoints?: WaypointService;
}

/** The only thing this needs from Phase 1. FieldSessionController satisfies it. */
export interface FieldSessionPort {
  getSnapshot(): SessionSnapshot;
  subscribe(l: () => void): () => void;
  start(): void;
  stop(): void;
}

/** Arrival threshold widens with GPS accuracy, so a ±40 m fix cannot flap (§3.5). */
export function arrivalRadiusM(accuracyM: number | null): number {
  return Math.max(50, (accuracyM ?? 0) * 2);
}

/**
 * Signed turn from where you face to where you should go, in [-180, 180).
 * Negative is left, positive is right. An exact about-face reports -180; the
 * sign is arbitrary there because both turns are the same size.
 */
export function relativeBearing(target: number, heading: number): number {
  return ((((target - heading) % 360) + 540) % 360) - 180;
}

type Listener = () => void;

export class ExplorationOrchestrator {
  private snap: ExplorationSnapshot = emptySnapshot();
  private listeners = new Set<Listener>();
  private unsubField: (() => void) | null = null;
  private seq = 0;
  private lastTargetedCell: string | null = null;
  private retargeting = false;
  private inspect: { lat: number; lng: number } | null = null;
  private cachedSnapshot: ExplorationSnapshot | null = null;

  constructor(private readonly deps: OrchestratorDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  // ── Read side ─────────────────────────────────────────────────────────────
  getSnapshot(): ExplorationSnapshot {
    this.cachedSnapshot ??= { ...this.snap };
    return this.cachedSnapshot;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  // ── Step 1: start ─────────────────────────────────────────────────────────
  start(): void {
    if (this.snap.state !== "idle" && this.snap.state !== "ended") return;
    const t = this.now;
    this.snap = {
      ...emptySnapshot(),
      state: "orienting",
      explorationSessionId: `ex-${t.toString(36)}-${++this.seq}`,
      startedAt: t,
    };
    this.lastTargetedCell = null;
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
    void this.retarget(true);
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
    this.patch({ inspecting: this.inspect, activeTarget: null });
    this.lastTargetedCell = null;
    void this.retarget(true);
  }

  /** Back to the real position. */
  clearInspect(): void {
    if (!this.inspect) return;
    this.inspect = null;
    this.patch({ inspecting: null, activeTarget: null });
    this.lastTargetedCell = null;
    void this.retarget(true);
  }

  /** The point the engine is answering about — inspected place, else the fix. */
  private activePoint(): { lat: number; lng: number } | null {
    if (this.inspect) return this.inspect;
    const f = this.deps.field.getSnapshot().lastFix;
    return f ? { lat: f.lat, lng: f.lng } : null;
  }

  /** Choose a different target from the ranked list. */
  selectTarget(cell: string): void {
    const t = this.snap.targets.find((x) => x.cell === cell);
    if (!t) return;
    this.patch({ activeTarget: t, state: "guiding" });
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
  async captureObservation(type: WaypointType, notes?: string): Promise<void> {
    if (this.snap.state === "idle" || this.snap.state === "ended") return;
    const trackId = this.snap.explorationSessionId;
    await this.deps.waypoints?.capture({ type, notes, trackId });
    await this.recordEvidence();
  }

  /**
   * Step 7 on its own: re-score from whatever evidence now exists. Used when
   * evidence was captured elsewhere (a scan, a waypoint from another screen).
   */
  async recordEvidence(): Promise<void> {
    if (this.snap.state === "idle" || this.snap.state === "ended") return;
    this.patch({ state: "reasoning", evidenceCount: this.snap.evidenceCount + 1 });
    await this.retarget(true);
  }

  // ── Field session bridge ──────────────────────────────────────────────────
  private onFieldChange(): void {
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
    this.patch({ position: { lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracy } });

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

    // Re-target only on a CELL change, never on every fix (Invariant 7).
    if (cell !== this.lastTargetedCell) void this.retarget(false);
  }

  private async retarget(force: boolean): Promise<void> {
    const point = this.activePoint();
    if (!point) return;
    if (this.retargeting && !force) return;
    this.retargeting = true;

    const cell = cellFor(point.lat, point.lng);
    try {
      const result = await this.deps.targeting.rank(point.lat, point.lng, this.deps.targetingOptions);
      this.lastTargetedCell = cell;

      const visited = this.snap.visitedCells.includes(cell)
        ? this.snap.visitedCells
        : [...this.snap.visitedCells, cell];

      // Keep walking to the same target if it is still on the list; otherwise
      // take the best. Recommendations must be stable, not restless.
      const stillActive = this.snap.activeTarget
        ? result.targets.find((t) => t.cell === this.snap.activeTarget!.cell) ?? null
        : null;
      const active = stillActive ?? result.targets[0] ?? null;

      this.patch({
        state: active ? "guiding" : "orienting",
        currentCell: cell,
        context: result.current.context,
        targets: result.targets,
        activeTarget: active,
        bestIsHere: result.bestIsHere,
        hasKnowledge: result.hasKnowledge,
        packProvenance: this.deps.packs.provenance(),
        packProblem: packProblemOf(this.deps.packs.getStatus()),
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

    const distanceToTargetM = haversine(fix.lat, fix.lng, target.centre.lat, target.centre.lng);
    const heading = f.lastHeading?.trueHeading;
    const relativeBearingDeg = heading == null ? null : relativeBearing(target.bearingDeg, heading);

    const arrived =
      distanceToTargetM <= arrivalRadiusM(fix.accuracy) &&
      this.snap.state === "guiding" &&
      !this.snap.suspendedBy;

    this.patch({
      distanceToTargetM,
      relativeBearingDeg,
      ...(arrived ? { state: "awaitingEvidence" as ExplorationState } : {}),
    });
  }

  // ── Plumbing ──────────────────────────────────────────────────────────────
  private patch(p: Partial<ExplorationSnapshot>): void {
    this.snap = { ...this.snap, ...p };
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
    inspecting: null,
    context: null,
    targets: [],
    activeTarget: null,
    distanceToTargetM: null,
    relativeBearingDeg: null,
    bestIsHere: false,
    hasKnowledge: false,
    packProvenance: null,
    packProblem: null,
    suspendedBy: null,
    evidenceCount: 0,
    visitedCells: [],
  };
}

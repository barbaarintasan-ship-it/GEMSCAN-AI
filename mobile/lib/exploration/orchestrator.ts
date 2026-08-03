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

  /** Choose a different target from the ranked list. */
  selectTarget(cell: string): void {
    const t = this.snap.targets.find((x) => x.cell === cell);
    if (!t) return;
    this.patch({ activeTarget: t, state: "guiding" });
    this.updateGuidance();
  }

  /**
   * Steps 6→7: evidence was captured, so the model must be re-scored NOW,
   * offline. This is what makes the app an assistant rather than a map.
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
    const f = this.deps.field.getSnapshot();
    const fix = f.lastFix;
    if (!fix) return;
    if (this.retargeting && !force) return;
    this.retargeting = true;

    const cell = cellFor(fix.lat, fix.lng);
    try {
      const result = await this.deps.targeting.rank(fix.lat, fix.lng, this.deps.targetingOptions);
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

function emptySnapshot(): ExplorationSnapshot {
  return {
    state: "idle",
    explorationSessionId: null,
    fieldSessionId: null,
    startedAt: null,
    endedAt: null,
    currentCell: null,
    context: null,
    targets: [],
    activeTarget: null,
    distanceToTargetM: null,
    relativeBearingDeg: null,
    bestIsHere: false,
    hasKnowledge: false,
    packProvenance: null,
    suspendedBy: null,
    evidenceCount: 0,
    visitedCells: [],
  };
}

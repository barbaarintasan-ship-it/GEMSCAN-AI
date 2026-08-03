// Field Exploration Engine — DiagnosticsRecorder (Phase 1, spec Part 11).
//
// Dev-only, passive observability. The controller feeds it at the points every
// event already flows through; the debug surface reads snapshots. Bounded
// memory (fixed ring buffers), in-memory only (position data is sensitive —
// export is a manual dev action), and a no-op when disabled so the release
// sensor path pays nothing.
import {
  DIAG_RING_CAPACITY,
  HEADING_MIN_DELTA_DEG,
  HEADING_MIN_INTERVAL_MS,
  LOW_ACCURACY_M,
  TRIPWIRE_WINDOW_MS,
  WALKING_PROFILE,
  type CleanupAudit,
  type CleanupCheck,
  type DiagCounters,
  type DiagTimings,
  type FieldFix,
  type FieldHeading,
  type HeadingServiceStatus,
  type LifecycleLogEntry,
  type LocationProfileConfig,
  type LocationServiceStatus,
  type MachineSnapshot,
  type MachineState,
  type PermissionResult,
  type SessionSnapshot,
  type TransitionLogEntry,
} from "./types";

// The recorder is a passive counter; the only surface that mounts a session is
// the diagnostics screen, which is reachable in release builds for field
// testing. Gating on __DEV__ therefore zeroed every metric on exactly the
// builds under test, so recording is on by default and the caller opts out.

function emptyCounters(): DiagCounters {
  return {
    fixesTotal: 0, fixesProvisional: 0, fixesLowAccuracy: 0,
    headingRaw: 0, headingEmitted: 0,
    dispatches: 0, errors: 0, watchRetries: 0,
    startStopCycles: 0, pausesUser: 0, pausesSystem: 0, resumes: 0,
  };
}

class Ring<T> {
  private buf: T[] = [];
  constructor(private cap: number) {}
  push(v: T): void {
    this.buf.push(v);
    if (this.buf.length > this.cap) this.buf.shift();
  }
  values(): T[] { return [...this.buf]; }
  clear(): void { this.buf = []; }
}

const INTERVAL_WINDOW = 10; // rolling mean window for update intervals

export class DiagnosticsRecorder {
  readonly enabled: boolean;
  private now: () => number;

  private counters = emptyCounters();
  private transitions = new Ring<TransitionLogEntry>(DIAG_RING_CAPACITY);
  private lifecycle = new Ring<LifecycleLogEntry>(DIAG_RING_CAPACITY);

  // Timings
  private sessionStartAt: number | null = null;
  private stateEnteredAt: number | null = null;
  private permissionStartAt: number | null = null;
  private permissionMs: number | null = null;
  private provisionalFixMs: number | null = null;
  private freshFixMs: number | null = null;
  private resumeStartAt: number | null = null;
  private resumeToFixMs: number | null = null;
  private lastFixAt: number | null = null;
  private fixIntervals: number[] = [];
  private lastHeadingAt: number | null = null;
  private headingIntervals: number[] = [];

  // Rolling accuracy window (last 10 fixes)
  private accuracies: number[] = [];

  // Cleanup verification
  private lastAudit: CleanupAudit | null = null;
  private tripwireArmedAt: number | null = null;
  private tripwireViolated = false;

  constructor(enabled: boolean = true, now: () => number = Date.now) {
    this.enabled = enabled;
    this.now = now;
  }

  // ── Session/window management ─────────────────────────────────────────────
  sessionStarted(): void {
    if (!this.enabled) return;
    // startStopCycles is per-app-run (spec 11.2) — it survives session resets.
    const cycles = this.counters.startStopCycles;
    this.counters = emptyCounters();
    this.counters.startStopCycles = cycles;
    this.transitions.clear();
    this.lifecycle.clear();
    this.sessionStartAt = this.now();
    this.stateEnteredAt = this.sessionStartAt;
    this.permissionMs = null;
    this.provisionalFixMs = null;
    this.freshFixMs = null;
    this.resumeToFixMs = null;
    this.lastFixAt = null;
    this.fixIntervals = [];
    this.lastHeadingAt = null;
    this.headingIntervals = [];
    this.accuracies = [];
    this.tripwireArmedAt = null;
    this.tripwireViolated = false;
    this.lastAudit = null;
  }

  // ── Logs ──────────────────────────────────────────────────────────────────
  transition(from: MachineState, event: string, to: MachineState): void {
    if (!this.enabled) return;
    const t = this.now();
    this.transitions.push({
      t, from, event, to,
      dwellMs: this.stateEnteredAt != null ? t - this.stateEnteredAt : 0,
    });
    this.stateEnteredAt = t;
  }

  log(msg: string, ignored = false): void {
    if (!this.enabled) return;
    this.lifecycle.push({ t: this.now(), msg, ignored });
  }

  // ── Counters + timings fed by the controller ──────────────────────────────
  permissionRequested(): void {
    if (!this.enabled) return;
    this.permissionStartAt = this.now();
  }
  permissionResolved(): void {
    if (!this.enabled || this.permissionStartAt == null) return;
    this.permissionMs = this.now() - this.permissionStartAt;
  }

  fix(fix: FieldFix): void {
    if (!this.enabled) return;
    // Post-stop tripwire: ANY sensor event inside the armed window is a
    // persistent violation (spec Part 9 criterion 2, self-checking).
    this.tripwireCheck("fix");
    const t = this.now();
    this.counters.fixesTotal++;
    if (fix.provisional) {
      this.counters.fixesProvisional++;
      if (this.provisionalFixMs == null && this.sessionStartAt != null) {
        this.provisionalFixMs = t - this.sessionStartAt;
      }
      return; // provisional fixes don't feed interval/accuracy stats
    }
    if (this.freshFixMs == null && this.sessionStartAt != null) {
      this.freshFixMs = t - this.sessionStartAt;
    }
    if (this.resumeStartAt != null) {
      this.resumeToFixMs = t - this.resumeStartAt;
      this.resumeStartAt = null;
    }
    if (fix.accuracy != null) {
      this.accuracies.push(fix.accuracy);
      if (this.accuracies.length > INTERVAL_WINDOW) this.accuracies.shift();
      if (fix.accuracy > LOW_ACCURACY_M) this.counters.fixesLowAccuracy++;
    }
    if (this.lastFixAt != null) {
      this.fixIntervals.push(t - this.lastFixAt);
      if (this.fixIntervals.length > INTERVAL_WINDOW) this.fixIntervals.shift();
    }
    this.lastFixAt = t;
  }

  headingRaw(): void {
    if (!this.enabled) return;
    this.counters.headingRaw++;
  }
  headingEmitted(): void {
    if (!this.enabled) return;
    this.tripwireCheck("heading");
    const t = this.now();
    this.counters.headingEmitted++;
    if (this.lastHeadingAt != null) {
      this.headingIntervals.push(t - this.lastHeadingAt);
      if (this.headingIntervals.length > INTERVAL_WINDOW) this.headingIntervals.shift();
    }
    this.lastHeadingAt = t;
  }

  dispatch(): void { if (this.enabled) this.counters.dispatches++; }
  error(): void { if (this.enabled) this.counters.errors++; }
  watchRetry(): void { if (this.enabled) this.counters.watchRetries++; }
  cycle(): void { if (this.enabled) this.counters.startStopCycles++; }
  pause(by: "user" | "system"): void {
    if (!this.enabled) return;
    if (by === "user") this.counters.pausesUser++; else this.counters.pausesSystem++;
  }
  resume(): void {
    if (!this.enabled) return;
    this.counters.resumes++;
    this.resumeStartAt = this.now();
  }

  // ── Cleanup verification (spec Part 11.5) ─────────────────────────────────
  armTripwire(): void {
    if (!this.enabled) return;
    this.tripwireArmedAt = this.now();
  }
  private tripwireCheck(kind: string): void {
    if (this.tripwireArmedAt == null) return;
    if (this.now() - this.tripwireArmedAt <= TRIPWIRE_WINDOW_MS) {
      this.tripwireViolated = true; // persistent red badge
      this.lifecycle.push({ t: this.now(), msg: `POST-STOP EVENT (${kind})` });
    }
  }
  tripwireStatus(): { armed: boolean; violated: boolean } {
    return { armed: this.tripwireArmedAt != null, violated: this.tripwireViolated };
  }

  audit(checks: CleanupCheck[]): CleanupAudit {
    const all: CleanupCheck[] = [
      ...checks,
      { name: "no post-stop events (tripwire)", pass: !this.tripwireViolated },
    ];
    const result: CleanupAudit = {
      t: this.now(),
      pass: all.every((c) => c.pass),
      checks: all,
    };
    if (this.enabled) this.lastAudit = result;
    return result;
  }
  getLastAudit(): CleanupAudit | null { return this.lastAudit; }

  // ── Read side (debug surface + export) ────────────────────────────────────
  getCounters(): DiagCounters { return { ...this.counters }; }
  getTransitions(): TransitionLogEntry[] { return this.transitions.values(); }
  getLifecycle(): LifecycleLogEntry[] { return this.lifecycle.values(); }
  getAccuracyStats(): { min: number; median: number; max: number } | null {
    if (this.accuracies.length === 0) return null;
    const s = [...this.accuracies].sort((a, b) => a - b);
    return { min: s[0], median: s[Math.floor(s.length / 2)], max: s[s.length - 1] };
  }
  getTimings(): DiagTimings {
    const mean = (xs: number[]) =>
      xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
    return {
      permissionMs: this.permissionMs,
      provisionalFixMs: this.provisionalFixMs,
      freshFixMs: this.freshFixMs,
      resumeToFixMs: this.resumeToFixMs,
      avgFixIntervalMs: mean(this.fixIntervals),
      avgHeadingIntervalMs: mean(this.headingIntervals),
    };
  }

  /** Clock the report builder shares, so exportedAt matches the ring timestamps. */
  clock(): number { return this.now(); }
}

// ── Report: the single source both the screen and the export render from ─────
// Two independent read paths (screen rows vs. an export that re-read the
// recorder with its own extras) is how they drifted apart. Everything the
// diagnostics screen displays now comes from this object, and Export is
// nothing but JSON.stringify of the same object.
export interface FieldDiagnosticsReport {
  exportedAt: string;
  recorderEnabled: boolean;
  device: { os: string; version: string } | null;
  config: {
    profile: LocationProfileConfig;
    headingGate: { minDeltaDeg: number; minIntervalMs: number };
    lowAccuracyM: number;
  };
  session: {
    id: string | null;
    state: string;              // the same label the screen shows
    machine: MachineSnapshot;
    startedAt: string | null;
    fixCount: number;           // non-provisional fixes accepted into the snapshot
    headingSupported: boolean;
    degradedAccuracy: boolean;
    permission: PermissionResult | null;
  };
  services: {
    locationStatus: LocationServiceStatus;
    headingStatus: HeadingServiceStatus;
    subscriptions: { position: number; heading: number; appState: number };
  };
  lastFix: FieldFix | null;
  lastHeading: FieldHeading | null;
  counters: DiagCounters;
  timings: DiagTimings;
  accuracy: { min: number; median: number; max: number } | null;
  transitions: TransitionLogEntry[];
  lifecycle: LifecycleLogEntry[];
  cleanupAudit: CleanupAudit | null;
  tripwire: { armed: boolean; violated: boolean };
}

/** State label used by the screen AND the export — one formatting rule. */
export function formatMachineState(m: MachineSnapshot): string {
  return `${m.state}${m.pausedBy ? ` (${m.pausedBy})` : ""}${m.errorCode ? ` [${m.errorCode}]` : ""}`;
}

export function buildFieldDiagnosticsReport(input: {
  recorder: DiagnosticsRecorder;
  snapshot: SessionSnapshot;
  locationStatus: LocationServiceStatus;
  headingStatus: HeadingServiceStatus;
  subscriptions: { position: number; heading: number; appState: number };
  headingCounts: { raw: number; emitted: number };
  device?: { os: string; version: string } | null;
}): FieldDiagnosticsReport {
  const { recorder: rec, snapshot: s } = input;
  // Heading raw/emitted live in the HeadingService (it owns the throttle gate);
  // the counters block carries them so the export can't disagree with the row.
  const counters: DiagCounters = {
    ...rec.getCounters(),
    headingRaw: input.headingCounts.raw,
    headingEmitted: input.headingCounts.emitted,
  };
  return {
    exportedAt: new Date(rec.clock()).toISOString(),
    recorderEnabled: rec.enabled,
    device: input.device ?? null,
    config: {
      profile: WALKING_PROFILE,
      headingGate: { minDeltaDeg: HEADING_MIN_DELTA_DEG, minIntervalMs: HEADING_MIN_INTERVAL_MS },
      lowAccuracyM: LOW_ACCURACY_M,
    },
    session: {
      id: s.sessionId,
      state: formatMachineState(s.machine),
      machine: s.machine,
      startedAt: s.startedAt != null ? new Date(s.startedAt).toISOString() : null,
      fixCount: s.fixCount,
      headingSupported: s.headingSupported,
      degradedAccuracy: s.degradedAccuracy,
      permission: s.permission,
    },
    services: {
      locationStatus: input.locationStatus,
      headingStatus: input.headingStatus,
      subscriptions: input.subscriptions,
    },
    lastFix: s.lastFix,
    lastHeading: s.lastHeading,
    counters,
    timings: rec.getTimings(),
    accuracy: rec.getAccuracyStats(),
    transitions: rec.getTransitions(),
    lifecycle: rec.getLifecycle(),
    cleanupAudit: rec.getLastAudit(),
    tripwire: rec.tripwireStatus(),
  };
}

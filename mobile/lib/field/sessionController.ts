// Field Exploration Engine — SessionController (Phase 1, spec Parts 3–5, 7).
//
// The single owner of the session: the pure state machine (exported separately
// for table tests), both sensor services, the AppState listener, and the
// in-memory snapshot. Commands that are illegal in the current state are
// LOGGED NO-OPS — nothing ever throws into React. Async flows carry a
// generation token so a stop() during any await simply abandons the flow.
import {
  RESUME_FIX_TIMEOUT_MS,
  WALKING_PROFILE,
  type FieldErrorCode,
  type FieldFix,
  type FieldHeading,
  type MachineSnapshot,
  type PausedBy,
  type SessionEvent,
  type SessionSnapshot,
} from "./types";
import { LocationService } from "./locationService";
import { HeadingService } from "./headingService";
import { DiagnosticsRecorder } from "./diagnostics";

// ── Pure transition function (spec Part 4 — the exact table) ────────────────
// Returns the next machine snapshot, or null when the event is illegal in the
// current state (caller records it as an ignored command).
export function transition(m: MachineSnapshot, ev: SessionEvent): MachineSnapshot | null {
  const s = m.state;
  switch (ev.type) {
    case "START":
      return s === "idle" ? { state: "requestingPermissions", pausedBy: null, errorCode: null } : null;
    case "PERM_GRANTED":
      return s === "requestingPermissions" ? { ...m, state: "starting" } : null;
    case "PERM_DENIED":
      return s === "requestingPermissions" ? { state: "error", pausedBy: null, errorCode: "permission" } : null;
    case "SERVICES_OFF":
      return s === "requestingPermissions" ? { state: "error", pausedBy: null, errorCode: "services" } : null;
    case "FIRST_FIX_OK":
      return s === "starting" ? { ...m, state: "active" } : null;
    case "FIRST_FIX_TIMEOUT":
      return s === "starting" ? { state: "error", pausedBy: null, errorCode: "no-gps" } : null;
    case "WATCH_FATAL":
      return s === "active" || s === "paused"
        ? { state: "error", pausedBy: null, errorCode: "sensor" } : null;
    case "PAUSE_USER":
      return s === "active" ? { ...m, state: "paused", pausedBy: "user" } : null;
    case "APP_BACKGROUND":
      return s === "active" ? { ...m, state: "paused", pausedBy: "system" } : null;
    case "RESUME_USER":
      return s === "paused" ? { ...m, state: "active", pausedBy: null } : null;
    case "APP_FOREGROUND":
      // User intent wins: a user-pause survives foregrounding.
      if (s === "paused" && m.pausedBy === "system") return { ...m, state: "active", pausedBy: null };
      return null;
    case "STOP":
      return s !== "idle" && s !== "stopping"
        ? { state: "stopping", pausedBy: null, errorCode: null } : null;
    case "CLEANUP_DONE":
      return s === "stopping" ? { state: "idle", pausedBy: null, errorCode: null } : null;
    case "RETRY":
      return s === "error" ? { state: "requestingPermissions", pausedBy: null, errorCode: null } : null;
    case "DISMISS":
      return s === "error" ? { state: "idle", pausedBy: null, errorCode: null } : null;
    default:
      return null;
  }
}

// ── AppState adapter (injected; default = react-native, required lazily) ────
export interface AppStateApi {
  subscribe(cb: (status: "active" | "background" | "inactive") => void): { remove(): void };
}

function createRnAppStateApi(): AppStateApi {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { AppState } = require("react-native");
  return {
    subscribe: (cb) => AppState.addEventListener("change", cb),
  };
}

export interface ControllerDeps {
  location?: LocationService;
  heading?: HeadingService;
  recorder?: DiagnosticsRecorder;
  appState?: AppStateApi;
}

type Listener = () => void;

let sessionSeq = 0;

export class FieldSessionController {
  readonly location: LocationService;
  readonly heading: HeadingService;
  readonly recorder: DiagnosticsRecorder;
  private appStateApi: AppStateApi;

  private snap: SessionSnapshot = emptySnapshot();
  private listeners = new Set<Listener>();
  private appStateSub: { remove(): void } | null = null;
  private unsubFix: (() => void) | null = null;
  private unsubHeading: (() => void) | null = null;
  private unsubUnavailable: (() => void) | null = null;
  private unsubLocError: (() => void) | null = null;
  private watchRetried = false;
  private flowGen = 0; // async-flow token: bumped by stop/destroy/retry

  constructor(deps: ControllerDeps = {}) {
    this.location = deps.location ?? new LocationService();
    this.heading = deps.heading ?? new HeadingService();
    this.recorder = deps.recorder ?? new DiagnosticsRecorder();
    this.appStateApi = deps.appState ?? createRnAppStateApi();
  }

  // ── Read side ─────────────────────────────────────────────────────────────
  getSnapshot(): SessionSnapshot { return this.snap; }
  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  /** Subscription counts for the diagnostics panel. */
  subscriptionCounts(): { position: number; heading: number; appState: number } {
    return {
      position: this.location.subscriptionCount(),
      heading: this.heading.subscriptionCount(),
      appState: this.appStateSub ? 1 : 0,
    };
  }

  // ── Commands (all safe to call in any state) ──────────────────────────────
  start(): void {
    if (this.snap.machine.state !== "idle") { this.ignored("start"); return; }
    this.recorder.sessionStarted();
    this.snap = {
      ...emptySnapshot(),
      sessionId: `fs-${Date.now().toString(36)}-${++sessionSeq}`,
      startedAt: Date.now(),
    };
    this.dispatch({ type: "START" });
    void this.runStartFlow();
  }

  retry(): void {
    if (!this.dispatch({ type: "RETRY" })) { this.ignored("retry"); return; }
    void this.runStartFlow();
  }

  dismiss(): void {
    if (!this.dispatch({ type: "DISMISS" })) this.ignored("dismiss");
  }

  pause(): void {
    if (this.dispatch({ type: "PAUSE_USER" })) {
      this.recorder.pause("user");
      this.stopSensors();
    } else this.ignored("pause");
  }

  resume(): void {
    if (this.dispatch({ type: "RESUME_USER" })) this.afterResume();
    else this.ignored("resume");
  }

  stop(): void {
    if (!this.dispatch({ type: "STOP" })) { this.ignored("stop"); return; }
    this.flowGen++; // abandon any in-flight start/permission flow
    this.teardown();
    this.dispatch({ type: "CLEANUP_DONE" });
  }

  /** Provider-unmount safety: hard stop from any state, always ends Idle. */
  destroy(): void {
    if (this.snap.machine.state !== "idle") this.stop();
    else this.teardown(); // belt-and-braces: also clears a half-built session
    this.listeners.clear();
  }

  // ── Start flow (permissions → first fix → sensors), spec Part 3/5 ─────────
  private async runStartFlow(): Promise<void> {
    const gen = ++this.flowGen;
    const alive = () => gen === this.flowGen;

    // Attach sensor listeners once per flow (idempotent via teardown).
    this.attachSensorListeners();
    this.appStateSub ??= this.appStateApi.subscribe((status) => {
      if (status === "active") {
        if (this.dispatch({ type: "APP_FOREGROUND" })) this.afterResume();
      } else if (this.dispatch({ type: "APP_BACKGROUND" })) {
        this.recorder.pause("system");
        this.stopSensors();
      }
    });

    // Permissions
    this.recorder.permissionRequested();
    let perm;
    try {
      perm = await this.location.requestPermissions();
    } catch {
      perm = { granted: false, preciseGranted: false, canAskAgain: true };
    }
    this.recorder.permissionResolved();
    if (!alive()) return;
    if (!perm.granted) {
      this.recorder.error();
      this.updateSnap({ permission: perm });
      this.dispatch({ type: "PERM_DENIED" });
      return;
    }
    let services = true;
    try { services = await this.location.checkServicesEnabled(); } catch { /* assume on */ }
    if (!alive()) return;
    if (!services) {
      this.recorder.error();
      this.updateSnap({ permission: perm });
      this.dispatch({ type: "SERVICES_OFF" });
      return;
    }
    this.updateSnap({ permission: perm, degradedAccuracy: !perm.preciseGranted });
    this.dispatch({ type: "PERM_GRANTED", precise: perm.preciseGranted });

    // First fix (provisional emitted via the fix listener as it arrives)
    const first = await this.location.acquireFirstFix();
    if (!alive()) return;
    if (!first.ok) {
      this.recorder.error();
      this.dispatch({ type: "FIRST_FIX_TIMEOUT" });
      return;
    }
    this.dispatch({ type: "FIRST_FIX_OK" });
    await this.startSensors();
  }

  private async startSensors(): Promise<void> {
    this.watchRetried = false;
    await this.location.start(WALKING_PROFILE);
    const headingOk = await this.heading.start();
    if (!headingOk && this.heading.getStatus() === "unavailable") {
      this.updateSnap({ headingSupported: false });
    }
  }

  private afterResume(): void {
    this.recorder.resume();
    void this.startSensors();
    void this.location.acquireQuickFix(RESUME_FIX_TIMEOUT_MS);
  }

  private stopSensors(): void {
    this.location.stop();
    this.heading.stop();
  }

  // ── Sensor event wiring ───────────────────────────────────────────────────
  private attachSensorListeners(): void {
    this.unsubFix ??= this.location.onFix((fix: FieldFix) => {
      const s = this.snap.machine.state;
      if (s !== "starting" && s !== "active") return;
      this.recorder.fix(fix);
      this.updateSnap({ lastFix: fix, fixCount: this.snap.fixCount + (fix.provisional ? 0 : 1) });
    });
    this.unsubHeading ??= this.heading.onHeading((h: FieldHeading) => {
      if (this.snap.machine.state !== "active") return;
      this.recorder.headingEmitted();
      this.updateSnap({ lastHeading: h });
    });
    this.unsubUnavailable ??= this.heading.onUnavailable(() => {
      this.updateSnap({ headingSupported: false });
    });
    this.unsubLocError ??= this.location.onError(() => {
      const s = this.snap.machine.state;
      if (s !== "active" && s !== "paused") return;
      if (!this.watchRetried) {
        // Single silent internal retry (spec Part 7).
        this.watchRetried = true;
        this.recorder.watchRetry();
        this.location.stop();
        void this.location.start(WALKING_PROFILE);
      } else {
        this.recorder.error();
        this.dispatch({ type: "WATCH_FATAL" });
        this.stopSensors();
      }
    });
  }

  // ── Teardown + cleanup audit (spec Parts 3, 11.5) ─────────────────────────
  private teardown(): void {
    this.stopSensors();
    if (this.appStateSub) {
      try { this.appStateSub.remove(); } catch { /* benign */ }
      this.appStateSub = null;
    }
    this.unsubFix?.(); this.unsubFix = null;
    this.unsubHeading?.(); this.unsubHeading = null;
    this.unsubUnavailable?.(); this.unsubUnavailable = null;
    this.unsubLocError?.(); this.unsubLocError = null;

    this.recorder.armTripwire();
    this.recorder.cycle();
    this.recorder.audit([
      { name: "location service idle", pass: this.location.getStatus() === "idle" },
      {
        name: "heading service stopped",
        pass: this.heading.getStatus() === "idle" || this.heading.getStatus() === "unavailable",
      },
      { name: "position subscriptions = 0", pass: this.location.subscriptionCount() === 0 },
      { name: "heading subscriptions = 0", pass: this.heading.subscriptionCount() === 0 },
      { name: "appState listener removed", pass: this.appStateSub === null },
    ]);
  }

  // ── Machine plumbing ──────────────────────────────────────────────────────
  /** Dispatch an event; returns true when a transition occurred. */
  private dispatch(ev: SessionEvent): boolean {
    const next = transition(this.snap.machine, ev);
    if (!next) return false;
    this.recorder.transition(this.snap.machine.state, ev.type, next.state);
    this.snap = { ...this.snap, machine: next };
    this.notify();
    return true;
  }

  private updateSnap(patch: Partial<SessionSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    this.notify();
  }

  private notify(): void {
    this.recorder.dispatch();
    for (const l of this.listeners) l();
  }

  private ignored(cmd: string): void {
    this.recorder.log(`command '${cmd}' ignored in state '${this.snap.machine.state}'`, true);
  }
}

function emptySnapshot(): SessionSnapshot {
  return {
    machine: { state: "idle", pausedBy: null, errorCode: null },
    sessionId: null,
    startedAt: null,
    lastFix: null,
    lastHeading: null,
    fixCount: 0,
    headingSupported: true,
    degradedAccuracy: false,
    permission: null,
  };
}

export type { FieldErrorCode, PausedBy };

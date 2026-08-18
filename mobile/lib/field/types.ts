// Field Exploration Engine — Phase 1 shared contracts (spec Parts 2–6).
//
// This module is 100% dependency-free (no expo/react imports) so every consumer
// — services, controller, diagnostics, and the pure unit tests — can import it
// without touching native modules. Services translate these shapes to/from the
// expo-location API behind an injected adapter (see locationService.ts).

// ── State machine (spec Part 4) ─────────────────────────────────────────────
export type MachineState =
  | "idle"
  | "requestingPermissions"
  | "starting"
  | "active"
  | "paused"
  | "error"
  | "stopping";

export type PausedBy = "user" | "system";

export type FieldErrorCode =
  | "permission" // foreground location permission denied
  | "services"   // device location services disabled
  | "no-gps"     // first-fix timeout
  | "sensor";    // watch failed after the single internal retry

// Machine events. WATCH_ERROR carries no payload — the controller manages the
// retry counter outside the pure transition function.
export type SessionEvent =
  | { type: "START" }
  | { type: "PERM_GRANTED"; precise: boolean }
  | { type: "PERM_DENIED" }
  | { type: "SERVICES_OFF" }
  | { type: "FIRST_FIX_OK" }
  | { type: "FIRST_FIX_TIMEOUT" }
  | { type: "WATCH_FATAL" } // watch failed AND retry already spent
  | { type: "PAUSE_USER" }
  | { type: "APP_BACKGROUND" }
  | { type: "RESUME_USER" }
  | { type: "APP_FOREGROUND" }
  | { type: "STOP" }
  | { type: "CLEANUP_DONE" }
  | { type: "RETRY" }
  | { type: "DISMISS" };

// The machine's own snapshot — state plus the two flags transitions depend on.
export interface MachineSnapshot {
  state: MachineState;
  pausedBy: PausedBy | null;
  errorCode: FieldErrorCode | null;
}

// ── Sensor shapes ───────────────────────────────────────────────────────────
export interface FieldFix {
  lat: number;
  lng: number;
  accuracy: number | null; // metres; null when the platform omits it
  altitude: number | null;
  speed: number | null;    // m/s
  timestamp: number;       // epoch ms
  provisional: boolean;    // true = last-known cache fix, not a fresh reading
}

export interface FieldHeading {
  trueHeading: number;     // 0–360; falls back to magnetic when true unavailable
  magneticHeading: number;
  accuracy: number;        // platform calibration level (higher = better)
  needsCalibration: boolean;
}

export interface PermissionResult {
  granted: boolean;
  preciseGranted: boolean; // false = Android/iOS "approximate only"
  canAskAgain: boolean;
}

export type LocationServiceStatus = "idle" | "acquiring" | "watching" | "error";
export type HeadingServiceStatus = "idle" | "watching" | "unavailable";

// ── Session snapshot exposed to the UI (spec Part 2, controller outputs) ────
export interface SessionSnapshot {
  machine: MachineSnapshot;
  sessionId: string | null;
  startedAt: number | null;
  lastFix: FieldFix | null;
  lastHeading: FieldHeading | null;
  fixCount: number;
  headingSupported: boolean;
  degradedAccuracy: boolean;  // approximate-only permission grant
  permission: PermissionResult | null;
}

// ── Battery / update strategy constants (spec Part 6) ───────────────────────
// P1 ships a single "walking" profile; the parameter exists for future profiles.
export type LocationProfileName = "walking";

export interface LocationProfileConfig {
  name: LocationProfileName;
  /**
   * "highest" maps to expo Location.Accuracy.BestForNavigation in the adapter.
   *
   * Balanced was costing the field session the receiver's best work: on Android
   * it is a ~100 m fused-provider mode that will happily answer from wifi and
   * cell towers, and a geologist recording where an outcrop is needs the GNSS
   * chip asked properly. The cost is battery, which is the right trade for a
   * session the user explicitly started and can see running.
   */
  accuracy: "highest";
  /**
   * Metres of movement before the OS delivers a fix. ZERO means "do not gate on
   * distance at all" — deliver on the time interval alone.
   *
   * THE FIELD REPORT THIS FIXES, in the reporter's own words: press the power
   * button, screen goes dark, double-tap to wake it — "GPS works immediately".
   * Then, a minute later, it does not.
   *
   * It was 5, with the comment "still silent when still". On Android
   * `watchPositionAsync` applies distance AND time together: a fix arrives only
   * once three seconds have passed AND the device has moved five metres. Standing
   * on an outcrop writing notes moves nobody five metres, so no fix ever arrived,
   * and the app correctly reported the position as stale — 63 seconds, 300
   * seconds, 703 seconds — while the geologist stood outside under a clear sky
   * with a receiver that was working perfectly.
   *
   * Waking the screen jostles the phone, ±11 m of noise crosses the five-metre
   * gate, one fix lands, and it looks fixed. Then it stops again. Exactly as
   * reported.
   *
   * Three things depend on fixes continuing while stationary, and all three were
   * broken by the gate:
   *   • the staleness warning, which counts TIME and so contradicted a watch
   *     gated on DISTANCE
   *   • ARRIVAL, judged on each fix — you stop walking when you get there, which
   *     is precisely when the fixes stopped
   *   • the accuracy readout a geologist uses to decide whether a position is
   *     worth recording
   *
   * The traverse is unaffected: TrackRecorder gates independently at
   * `minDistanceM: 10` plus an accuracy factor, described there as the safety net
   * for platforms that ignore the OS gate and burst. It never relied on this.
   *
   * The cost is battery, on a session the user explicitly started, on a screen
   * this app already holds awake for the same reason.
   */
  distanceIntervalM: number;
  timeIntervalMs: number;
}

export const WALKING_PROFILE: LocationProfileConfig = {
  name: "walking",
  accuracy: "highest",   // BestForNavigation — raw GNSS, the best the chip can do
  distanceIntervalM: 0,  // deliver on TIME alone — see the note above
  // 1 Hz, the standard navigation rate. Was 3000 ms; at BestForNavigation the fused
  // provider is not the source, so the burst that floor guarded against does not
  // arise, and a fix every second lets the accuracy CONVERGE quickly (a cold GNSS
  // reads ±20 m and tightens to a few metres over the first seconds) and keeps the
  // readout a geologist records against fresh. No phone GPS reaches 0 m — this is
  // the most accurate the hardware allows.
  timeIntervalMs: 1000,
};

export const FIRST_FIX_TIMEOUT_MS = 30_000;
export const RESUME_FIX_TIMEOUT_MS = 10_000; // quick re-acquire on resume (non-fatal)
export const LAST_KNOWN_MAX_AGE_MS = 60_000; // provisional fix freshness window
export const LOW_ACCURACY_M = 50;            // fixes above this are flagged, not dropped

export const HEADING_MIN_INTERVAL_MS = 500;  // ≤2 Hz to React
export const HEADING_MIN_DELTA_DEG = 3;      // suppress micro-jitter
export const HEADING_CALIBRATION_MIN = 2;    // platform accuracy below this ⇒ calibrate hint

// ── Diagnostics (spec Part 11) ──────────────────────────────────────────────
export const DIAG_RING_CAPACITY = 200;
export const TRIPWIRE_WINDOW_MS = 2000;

export interface TransitionLogEntry {
  t: number;
  from: MachineState;
  event: string;
  to: MachineState;
  dwellMs: number; // time spent in `from`
}

export interface LifecycleLogEntry {
  t: number;
  msg: string;
  ignored?: boolean; // illegal command recorded as a no-op
}

export interface DiagCounters {
  fixesTotal: number;
  fixesProvisional: number;
  fixesLowAccuracy: number;
  headingRaw: number;
  headingEmitted: number;
  dispatches: number;
  errors: number;
  watchRetries: number;
  startStopCycles: number;
  pausesUser: number;
  pausesSystem: number;
  resumes: number;
}

export interface CleanupCheck {
  name: string;
  pass: boolean;
}

export interface CleanupAudit {
  t: number;
  pass: boolean;
  checks: CleanupCheck[];
}

export interface DiagTimings {
  permissionMs: number | null;
  provisionalFixMs: number | null;
  freshFixMs: number | null;
  resumeToFixMs: number | null;
  avgFixIntervalMs: number | null;   // rolling mean of the last 10 inter-arrival gaps
  avgHeadingIntervalMs: number | null;
}

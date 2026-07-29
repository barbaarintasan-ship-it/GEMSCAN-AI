// Field Exploration Engine — LocationService (Phase 1, spec Part 2).
//
// Owns every expo-location POSITION touchpoint for a field session: permission
// request (with Android/iOS approximate-only detection), first-fix acquisition
// (provisional last-known immediately, fresh fix raced against a timeout — the
// proven pattern from lib/location.ts / captureSampleLocation), and exactly ONE
// watch subscription. No business logic: every fix is normalized and emitted
// with its accuracy so consumers decide what to do with it.
//
// The expo API sits behind an injected adapter (LocationApi) so unit tests run
// with fakes and never touch native modules; the real adapter is created
// lazily on first use (never at import time).
import {
  FIRST_FIX_TIMEOUT_MS,
  LAST_KNOWN_MAX_AGE_MS,
  WALKING_PROFILE,
  type FieldFix,
  type LocationProfileConfig,
  type LocationServiceStatus,
  type PermissionResult,
} from "./types";

// Raw platform fix (subset of expo's LocationObject we consume).
export interface RawFix {
  coords: {
    latitude: number;
    longitude: number;
    accuracy?: number | null;
    altitude?: number | null;
    speed?: number | null;
  };
  timestamp: number;
}

export interface WatchSubscription { remove(): void }

// The injected platform adapter — OUR terms, translated to expo inside the
// default adapter only.
export interface LocationApi {
  requestPermissions(): Promise<PermissionResult>;
  servicesEnabled(): Promise<boolean>;
  lastKnown(maxAgeMs: number): Promise<RawFix | null>;
  currentFix(): Promise<RawFix>;
  watch(profile: LocationProfileConfig, cb: (fix: RawFix) => void): Promise<WatchSubscription>;
}

export type FirstFixResult =
  | { ok: true; fix: FieldFix }
  | { ok: false; timedOut: true; provisional: FieldFix | null };

type FixListener = (fix: FieldFix) => void;
type ErrorListener = (message: string) => void;

function normalize(raw: RawFix, provisional: boolean): FieldFix {
  const c = raw.coords;
  return {
    lat: c.latitude,
    lng: c.longitude,
    accuracy: typeof c.accuracy === "number" ? Math.round(c.accuracy) : null,
    altitude: typeof c.altitude === "number" ? c.altitude : null,
    speed: typeof c.speed === "number" ? c.speed : null,
    timestamp: raw.timestamp,
    provisional,
  };
}

export class LocationService {
  private api: LocationApi;
  private status: LocationServiceStatus = "idle";
  private sub: WatchSubscription | null = null;
  // Generation guard: watch() resolves async — if stop() lands first, the
  // late-arriving subscription is removed immediately (no orphan watcher).
  private generation = 0;
  private fixListeners = new Set<FixListener>();
  private errorListeners = new Set<ErrorListener>();

  constructor(api?: LocationApi) {
    this.api = api ?? createExpoLocationApi();
  }

  getStatus(): LocationServiceStatus { return this.status; }
  /** Live subscription count for diagnostics (0 or 1 by invariant). */
  subscriptionCount(): number { return this.sub ? 1 : 0; }

  onFix(l: FixListener): () => void {
    this.fixListeners.add(l);
    return () => this.fixListeners.delete(l);
  }
  onError(l: ErrorListener): () => void {
    this.errorListeners.add(l);
    return () => this.errorListeners.delete(l);
  }

  requestPermissions(): Promise<PermissionResult> {
    return this.api.requestPermissions();
  }

  checkServicesEnabled(): Promise<boolean> {
    return this.api.servicesEnabled();
  }

  /**
   * First fix: emit a provisional last-known fix immediately (if fresh enough),
   * then race one fresh reading against the timeout. Never hangs; never throws.
   */
  async acquireFirstFix(timeoutMs: number = FIRST_FIX_TIMEOUT_MS): Promise<FirstFixResult> {
    this.status = "acquiring";
    let provisional: FieldFix | null = null;
    try {
      const last = await this.api.lastKnown(LAST_KNOWN_MAX_AGE_MS);
      if (last) {
        provisional = normalize(last, true);
        this.emitFix(provisional);
      }
    } catch { /* last-known is best-effort */ }

    try {
      const fresh = await withTimeout(this.api.currentFix(), timeoutMs);
      if (fresh === TIMEOUT) {
        this.status = "idle";
        return { ok: false, timedOut: true, provisional };
      }
      const fix = normalize(fresh, false);
      this.status = "idle"; // watch() flips it to "watching"
      this.emitFix(fix);
      return { ok: true, fix };
    } catch {
      this.status = "idle";
      return { ok: false, timedOut: true, provisional };
    }
  }

  /**
   * Quick, non-fatal re-acquire used on resume. Emits on success, silent on
   * failure (the watch will deliver soon anyway).
   */
  async acquireQuickFix(timeoutMs: number): Promise<void> {
    try {
      const fresh = await withTimeout(this.api.currentFix(), timeoutMs);
      if (fresh !== TIMEOUT) this.emitFix(normalize(fresh, false));
    } catch { /* non-fatal by contract */ }
  }

  /**
   * Start the continuous watch. Single-subscription invariant: returns false
   * (and does nothing) if already watching. Watch errors surface via onError.
   */
  async start(profile: LocationProfileConfig = WALKING_PROFILE): Promise<boolean> {
    if (this.sub || this.status === "watching") return false;
    const gen = ++this.generation;
    this.status = "watching";
    try {
      const sub = await this.api.watch(profile, (raw) => {
        if (gen !== this.generation) return; // stopped while in flight
        this.emitFix(normalize(raw, false));
      });
      if (gen !== this.generation) { sub.remove(); return false; } // stop() won the race
      this.sub = sub;
      return true;
    } catch (e) {
      if (gen === this.generation) {
        this.status = "error";
        this.emitError(e instanceof Error ? e.message : "watch failed");
      }
      return false;
    }
  }

  /** Idempotent. After this resolves, no further fix events are delivered. */
  stop(): void {
    this.generation++; // invalidates any in-flight watch() resolution
    if (this.sub) {
      try { this.sub.remove(); } catch { /* platform teardown races are benign */ }
      this.sub = null;
    }
    this.status = "idle";
  }

  private emitFix(fix: FieldFix): void {
    for (const l of this.fixListeners) l(fix);
  }
  private emitError(msg: string): void {
    for (const l of this.errorListeners) l(msg);
  }
}

// ── Timeout race helper ─────────────────────────────────────────────────────
const TIMEOUT = Symbol("timeout");
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(TIMEOUT), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

// ── Default adapter — the ONLY place expo-location is referenced ────────────
// Required lazily so importing this module never loads native code (keeps unit
// tests pure and import order irrelevant).
function createExpoLocationApi(): LocationApi {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Location = require("expo-location");
  return {
    async requestPermissions(): Promise<PermissionResult> {
      const r = await Location.requestForegroundPermissionsAsync();
      // Approximate-only detection: Android reports accuracy 'fine'|'coarse';
      // iOS reports scope. Unknown/missing platform detail ⇒ treat as precise.
      const androidCoarse = r?.android?.accuracy === "coarse";
      const iosReduced = r?.ios?.scope === "reduced" || r?.ios?.scope === "coarse";
      return {
        granted: !!r?.granted,
        preciseGranted: !!r?.granted && !androidCoarse && !iosReduced,
        canAskAgain: r?.canAskAgain !== false,
      };
    },
    servicesEnabled: () => Location.hasServicesEnabledAsync(),
    async lastKnown(maxAgeMs: number): Promise<RawFix | null> {
      const r = await Location.getLastKnownPositionAsync({ maxAge: maxAgeMs });
      return r ?? null;
    },
    currentFix: () =>
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
    watch: (profile, cb) =>
      Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Balanced,
          distanceInterval: profile.distanceIntervalM,
          timeInterval: profile.timeIntervalMs,
        },
        cb,
      ),
  };
}

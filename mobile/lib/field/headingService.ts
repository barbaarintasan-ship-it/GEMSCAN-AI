// Field Exploration Engine — HeadingService (Phase 1, spec Part 2).
//
// Owns expo-location's watchHeadingAsync. Responsibilities: circular low-pass
// smoothing (the 359°→0° wrap handled on the unit circle, never by naive
// averaging), the ≤2 Hz / ≥3° emission gate (React re-renders are the real
// cost, not the magnetometer), calibration flagging, and a first-class
// "unavailable" path — a device without a usable compass degrades the feature,
// never the session. Same injected-adapter + generation-guard pattern as
// LocationService.
import {
  HEADING_CALIBRATION_MIN,
  HEADING_MIN_DELTA_DEG,
  HEADING_MIN_INTERVAL_MS,
  type FieldHeading,
  type HeadingServiceStatus,
} from "./types";
import type { WatchSubscription } from "./locationService";

// Raw platform heading (subset of expo's LocationHeadingObject).
export interface RawHeading {
  trueHeading: number;     // may be <0 when unavailable on the platform
  magHeading: number;
  accuracy: number;        // calibration level, higher = better
}

export interface HeadingApi {
  watchHeading(cb: (h: RawHeading) => void): Promise<WatchSubscription>;
}

type HeadingListener = (h: FieldHeading) => void;
type UnavailableListener = () => void;

// Smallest signed angular difference (a - b) in degrees, in (-180, 180].
export function angularDelta(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

// Circular low-pass: blend on the unit circle so 359° and 1° average to ~0°,
// never 180°. alpha = weight of the new reading.
export function circularSmooth(prevDeg: number, nextDeg: number, alpha: number): number {
  const p = (prevDeg * Math.PI) / 180;
  const n = (nextDeg * Math.PI) / 180;
  const sin = (1 - alpha) * Math.sin(p) + alpha * Math.sin(n);
  const cos = (1 - alpha) * Math.cos(p) + alpha * Math.cos(n);
  const deg = (Math.atan2(sin, cos) * 180) / Math.PI;
  return (deg + 360) % 360;
}

const SMOOTH_ALPHA = 0.3;

export class HeadingService {
  private api: HeadingApi;
  private status: HeadingServiceStatus = "idle";
  private sub: WatchSubscription | null = null;
  private generation = 0;
  private listeners = new Set<HeadingListener>();
  private unavailableListeners = new Set<UnavailableListener>();
  private now: () => number;

  // Smoothing/gating state
  private smoothed: number | null = null;
  private lastEmittedDeg: number | null = null;
  private lastEmitAt = 0;
  private rawCount = 0;
  private emitCount = 0;

  constructor(api?: HeadingApi, now: () => number = Date.now) {
    this.api = api ?? createExpoHeadingApi();
    this.now = now;
  }

  getStatus(): HeadingServiceStatus { return this.status; }
  subscriptionCount(): number { return this.sub ? 1 : 0; }
  /** Raw vs emitted counts — the throttle-ratio input for diagnostics. */
  counts(): { raw: number; emitted: number } {
    return { raw: this.rawCount, emitted: this.emitCount };
  }

  onHeading(l: HeadingListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  onUnavailable(l: UnavailableListener): () => void {
    this.unavailableListeners.add(l);
    return () => this.unavailableListeners.delete(l);
  }

  /**
   * Start watching. Single-subscription invariant (false on double-start).
   * Failure to start ⇒ status "unavailable" + event — non-fatal by contract.
   */
  async start(): Promise<boolean> {
    if (this.sub || this.status === "watching") return false;
    const gen = ++this.generation;
    this.status = "watching";
    try {
      const sub = await this.api.watchHeading((raw) => {
        if (gen !== this.generation) return;
        this.ingest(raw);
      });
      if (gen !== this.generation) { sub.remove(); return false; }
      this.sub = sub;
      return true;
    } catch {
      if (gen === this.generation) {
        this.status = "unavailable";
        for (const l of this.unavailableListeners) l();
      }
      return false;
    }
  }

  /** Idempotent; resets smoothing state so a restart begins clean. */
  stop(): void {
    this.generation++;
    if (this.sub) {
      try { this.sub.remove(); } catch { /* benign */ }
      this.sub = null;
    }
    if (this.status !== "unavailable") this.status = "idle";
    this.smoothed = null;
    this.lastEmittedDeg = null;
    this.lastEmitAt = 0;
  }

  private ingest(raw: RawHeading): void {
    this.rawCount++;
    // trueHeading < 0 ⇒ platform can't provide it (no location for declination);
    // fall back to magnetic so the compass still works.
    const source = raw.trueHeading >= 0 ? raw.trueHeading : raw.magHeading;
    this.smoothed = this.smoothed == null
      ? ((source % 360) + 360) % 360
      : circularSmooth(this.smoothed, source, SMOOTH_ALPHA);

    const t = this.now();
    // First emission always passes; the ≥3° AND ≥500 ms gate applies BETWEEN
    // emissions (a fake/epoch-zero clock must not suppress the first reading).
    const first = this.lastEmittedDeg == null;
    const deltaOk = first
      || Math.abs(angularDelta(this.smoothed, this.lastEmittedDeg as number)) >= HEADING_MIN_DELTA_DEG;
    const timeOk = first || t - this.lastEmitAt >= HEADING_MIN_INTERVAL_MS;
    if (!(deltaOk && timeOk)) return;

    this.lastEmittedDeg = this.smoothed;
    this.lastEmitAt = t;
    this.emitCount++;
    const heading: FieldHeading = {
      trueHeading: this.smoothed,
      magneticHeading: ((raw.magHeading % 360) + 360) % 360,
      accuracy: raw.accuracy,
      needsCalibration: raw.accuracy < HEADING_CALIBRATION_MIN,
    };
    for (const l of this.listeners) l(heading);
  }
}

// ── Default adapter — the only expo touchpoint, required lazily ─────────────
function createExpoHeadingApi(): HeadingApi {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Location = require("expo-location");
  return {
    watchHeading: (cb) =>
      Location.watchHeadingAsync((h: { trueHeading: number; magHeading: number; accuracy: number }) =>
        cb({ trueHeading: h.trueHeading, magHeading: h.magHeading, accuracy: h.accuracy }),
      ),
  };
}

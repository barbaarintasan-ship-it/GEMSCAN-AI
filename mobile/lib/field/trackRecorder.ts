// Field Exploration Engine — TrackRecorder (Phase 2, Step 1).
//
// Phase 1 streams fixes and keeps only the latest one; nothing accumulates. The
// track recorder is the first Phase 2 component: it turns that stream into a
// traverse — an ordered, decimated breadcrumb split into segments, with stats
// that stay correct no matter how the stored points are later thinned.
//
// Like types.ts this module is 100% dependency-free (no expo, no react, no
// react-native), so the whole ingest policy is unit-testable without native
// modules. It reads Phase 1's contracts and constants; it does not change them.
import { LOW_ACCURACY_M, WALKING_PROFILE, type FieldFix } from "./types";
import { haversineM } from "../../../shared/geo-core/geo/spatial.ts";

// ── Stored shapes ───────────────────────────────────────────────────────────
export interface TrackPoint {
  lat: number;
  lng: number;
  accuracy: number | null; // metres, as reported
  altitude: number | null;
  t: number;               // epoch ms
  segment: number;         // index into the segment list
}

export type SegmentBreakReason = "pause" | "background" | "signal-loss" | "manual";

export interface TrackSegment {
  index: number;
  startedAt: number;
  endedAt: number | null;      // null while it is the open segment
  pointCount: number;          // points ACCEPTED into it, before any thinning
  distanceM: number;
  closedBy: SegmentBreakReason | null;
}

export interface TrackBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

// Why a fix did not become a point. Every rejection is counted, never silent —
// an empty track has to be explainable after the fact from the field.
export type RejectReason =
  | "inactive"     // recorder not recording
  | "provisional"  // last-known cache fix, not a real position (Phase 1 flag)
  | "stale"        // timestamp at or before the last accepted point
  | "inaccurate"   // accuracy worse than the hard gate
  | "stationary"   // movement inside the noise gate, and not yet due a resample
  | "spike";       // implied speed physically implausible ⇒ bad fix, not travel

export type IngestResult =
  | { accepted: true; point: TrackPoint; startedSegment: boolean; movedM: number }
  | { accepted: false; reason: RejectReason };

export interface TrackStats {
  distanceM: number;
  durationMs: number;      // wall clock, first accepted point → last
  movingMs: number;        // time attributed to actual travel (excludes standing)
  ascentM: number;
  descentM: number;
  pointsAccepted: number;  // lifetime, before thinning
  pointsStored: number;    // currently retained in memory
  rejected: Record<RejectReason, number>;
  segments: number;
  resolutionM: number;     // effective movement gate right now (grows when thinned)
  thinCount: number;       // how many times storage was halved
  bounds: TrackBounds | null;
  firstAt: number | null;
  lastAt: number | null;
}

export interface TrackSnapshot {
  sessionId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  recording: boolean;
  points: readonly TrackPoint[];
  segments: readonly TrackSegment[];
  stats: TrackStats;
}

// ── Configuration ───────────────────────────────────────────────────────────
export interface TrackConfig {
  /** Floor on real movement. The OS already gates at WALKING_PROFILE.distanceIntervalM;
   *  this is the safety net for platforms that ignore it and burst. */
  minDistanceM: number;
  /** Movement must also clear accuracy × this, so a ±40 m fix cannot fake a walk. */
  accuracyGateFactor: number;
  /** Hard reject above this. Phase 1 only FLAGS at LOW_ACCURACY_M; a map line
   *  needs a stricter gate than a readout, but not so strict that a canopy or
   *  a pit wall empties the track. */
  maxAccuracyM: number;
  /** Implied speed above this is a GPS spike, not a person walking. */
  maxSpeedMps: number;
  /** Below this, elapsed time counts as standing rather than travel. */
  movingMinSpeedMps: number;
  /** Keep one point this often even while stationary, so a long stop is visible. */
  idleResampleMs: number;
  /** A gap this long means the stream died; the next fix opens a new segment
   *  rather than drawing a straight line across the hole. */
  segmentGapMs: number;
  /** Altitude deltas below this are noise, not relief. */
  altitudeNoiseM: number;
  /** Storage ceiling. Reaching it halves resolution; it never truncates. */
  maxPoints: number;
}

export const DEFAULT_TRACK_CONFIG: TrackConfig = {
  minDistanceM: Math.round(WALKING_PROFILE.distanceIntervalM * 0.67), // 10 m
  accuracyGateFactor: 0.5,
  maxAccuracyM: LOW_ACCURACY_M * 2, // 100 m
  maxSpeedMps: 15,                  // 54 km/h — far above any traverse on foot
  movingMinSpeedMps: 0.3,
  idleResampleMs: 60_000,
  segmentGapMs: 300_000,
  altitudeNoiseM: 5,
  maxPoints: 5_000,                 // ≈ 14 h of walking at one point per 10 s
};

// ── Geometry ────────────────────────────────────────────────────────────────
// The distance formula is the SHARED one (shared/geo-core/geo/spatial.ts), the
// same function the offline gateway uses to answer ST_Distance. A traverse's
// length and an occurrence's distance must be measured identically, and a
// second copy here is exactly how that would quietly stop being true.
export { haversineM };

function emptyRejected(): Record<RejectReason, number> {
  return { inactive: 0, provisional: 0, stale: 0, inaccurate: 0, stationary: 0, spike: 0 };
}

type Listener = () => void;

/**
 * Ordered breadcrumb store for one field session.
 *
 * Two invariants carry the whole design:
 *
 *  1. **Stats are accumulated at ingest, never recomputed from stored points.**
 *     Distance, ascent and moving time are added as each fix is accepted, so
 *     thinning storage later cannot silently shrink the traverse a geologist
 *     actually walked.
 *  2. **Memory is bounded without losing the traverse.** At capacity the track
 *     halves its stored resolution (keeping every segment's endpoints) and
 *     doubles the movement gate, instead of dropping the oldest points — the
 *     start of a traverse matters as much as the end.
 */
export class TrackRecorder {
  readonly config: TrackConfig;
  private now: () => number;

  private points: TrackPoint[] = [];
  private segments: TrackSegment[] = [];
  private listeners = new Set<Listener>();

  private sessionId: string | null = null;
  private startedAt: number | null = null;
  private endedAt: number | null = null;
  private recording = false;
  private pendingBreak: SegmentBreakReason | null = null;

  // Ingest cursor — deliberately independent of `points`, which thinning edits.
  private last: TrackPoint | null = null;
  private lastKeptAt: number | null = null;   // last point retained in a segment
  private altReference: number | null = null; // hysteresis anchor for ascent/descent

  private distanceM = 0;
  private movingMs = 0;
  private ascentM = 0;
  private descentM = 0;
  private pointsAccepted = 0;
  private rejected = emptyRejected();
  private firstAt: number | null = null;
  private lastAt: number | null = null;
  private bounds: TrackBounds | null = null;
  private thinCount = 0;

  private snapshotCache: TrackSnapshot | null = null;

  constructor(config: Partial<TrackConfig> = {}, now: () => number = Date.now) {
    this.config = { ...DEFAULT_TRACK_CONFIG, ...config };
    this.now = now;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  /** Open a track for a session. Discards anything held for a previous one. */
  begin(sessionId: string, startedAt: number = this.now()): void {
    this.reset();
    this.sessionId = sessionId;
    this.startedAt = startedAt;
    this.recording = true;
    this.invalidate();
  }

  /** Close the track. Stored points and stats stay readable for handoff. */
  end(endedAt: number = this.now()): void {
    if (!this.recording) return;
    this.recording = false;
    this.endedAt = endedAt;
    const open = this.openSegment();
    if (open && open.endedAt == null) open.endedAt = this.lastAt ?? endedAt;
    this.invalidate();
  }

  /**
   * Close the current segment. The next accepted fix opens a new one, so a
   * pause, a backgrounded app or a dead signal leaves a gap in the drawn line
   * rather than a straight edge across ground nobody walked.
   */
  breakSegment(reason: SegmentBreakReason): void {
    if (!this.recording) return;
    const open = this.openSegment();
    // Nothing to break before the first point; remember it for the next accept.
    if (!open) { this.pendingBreak = reason; return; }
    open.endedAt = this.lastAt;
    open.closedBy = reason;
    this.last = null;        // no distance across the gap
    this.lastKeptAt = null;
    this.pendingBreak = null;
    this.invalidate();
  }

  reset(): void {
    this.points = [];
    this.segments = [];
    this.sessionId = null;
    this.startedAt = null;
    this.endedAt = null;
    this.recording = false;
    this.pendingBreak = null;
    this.last = null;
    this.lastKeptAt = null;
    this.altReference = null;
    this.distanceM = 0;
    this.movingMs = 0;
    this.ascentM = 0;
    this.descentM = 0;
    this.pointsAccepted = 0;
    this.rejected = emptyRejected();
    this.firstAt = null;
    this.lastAt = null;
    this.bounds = null;
    this.thinCount = 0;
    this.invalidate();
  }

  // ── Ingest ────────────────────────────────────────────────────────────────
  /**
   * Offer one Phase 1 fix to the track. Never throws: every fix either becomes
   * a point or returns a counted reason.
   */
  addFix(fix: FieldFix): IngestResult {
    if (!this.recording) return this.reject("inactive");
    // A provisional fix is a cached last-known position — right for showing the
    // user something immediately, wrong for asserting they stood there.
    if (fix.provisional) return this.reject("provisional");
    if (fix.accuracy != null && fix.accuracy > this.config.maxAccuracyM) {
      return this.reject("inaccurate");
    }

    const prev = this.last;
    if (prev && fix.timestamp <= prev.t) return this.reject("stale");

    let movedM = 0;
    let dt = 0;
    let startedSegment = prev == null;

    if (prev) {
      dt = fix.timestamp - prev.t;
      movedM = haversineM(prev, fix);
      if (dt > this.config.segmentGapMs) {
        // The stream died and came back somewhere else; don't bridge the hole.
        this.breakSegment("signal-loss");
        startedSegment = true;
      } else {
        const speed = movedM / (dt / 1000);
        if (speed > this.config.maxSpeedMps) return this.reject("spike");
        if (movedM < this.movementGate(fix.accuracy)) {
          // Standing still: keep one point per idle window so the stop is
          // visible on the timeline, and drop the rest.
          const sinceKept = this.lastKeptAt == null ? Infinity : fix.timestamp - this.lastKeptAt;
          if (sinceKept < this.config.idleResampleMs) return this.reject("stationary");
          return this.acceptPoint(fix, 0, 0, false);
        }
      }
    }

    return this.acceptPoint(fix, startedSegment ? 0 : movedM, startedSegment ? 0 : dt, startedSegment);
  }

  /** Movement gate for a fix: the floor, widened by how uncertain the fix is. */
  private movementGate(accuracy: number | null): number {
    const fromAccuracy = (accuracy ?? 0) * this.config.accuracyGateFactor;
    return Math.max(this.config.minDistanceM * 2 ** this.thinCount, fromAccuracy);
  }

  private acceptPoint(
    fix: FieldFix,
    movedM: number,
    dt: number,
    startedSegment: boolean,
  ): IngestResult {
    const segment = this.ensureSegment(fix.timestamp, startedSegment);
    const point: TrackPoint = {
      lat: fix.lat,
      lng: fix.lng,
      accuracy: fix.accuracy,
      altitude: fix.altitude,
      t: fix.timestamp,
      segment: segment.index,
    };

    this.points.push(point);
    this.pointsAccepted++;
    this.last = point;
    this.lastKeptAt = fix.timestamp;
    segment.pointCount++;

    if (movedM > 0) {
      this.distanceM += movedM;
      segment.distanceM += movedM;
      // Only travel counts as moving time; an idle resample contributes nothing.
      if (dt > 0 && movedM / (dt / 1000) >= this.config.movingMinSpeedMps) this.movingMs += dt;
    }

    this.accumulateRelief(fix.altitude);
    this.firstAt ??= fix.timestamp;
    this.lastAt = fix.timestamp;
    this.extendBounds(point);

    if (this.points.length > this.config.maxPoints) this.thin();

    this.invalidate();
    return { accepted: true, point, startedSegment, movedM };
  }

  /** Ascent/descent with hysteresis — raw GPS altitude wanders metres at rest. */
  private accumulateRelief(altitude: number | null): void {
    if (altitude == null) return;
    if (this.altReference == null) { this.altReference = altitude; return; }
    const delta = altitude - this.altReference;
    if (Math.abs(delta) < this.config.altitudeNoiseM) return;
    if (delta > 0) this.ascentM += delta; else this.descentM += -delta;
    this.altReference = altitude;
  }

  private extendBounds(p: TrackPoint): void {
    if (!this.bounds) {
      this.bounds = { minLat: p.lat, maxLat: p.lat, minLng: p.lng, maxLng: p.lng };
      return;
    }
    const b = this.bounds;
    if (p.lat < b.minLat) b.minLat = p.lat;
    if (p.lat > b.maxLat) b.maxLat = p.lat;
    if (p.lng < b.minLng) b.minLng = p.lng;
    if (p.lng > b.maxLng) b.maxLng = p.lng;
  }

  private openSegment(): TrackSegment | null {
    const s = this.segments[this.segments.length - 1];
    return s && s.endedAt == null ? s : null;
  }

  private ensureSegment(t: number, forceNew: boolean): TrackSegment {
    const open = this.openSegment();
    if (open && !forceNew && !this.pendingBreak) return open;
    if (open && (forceNew || this.pendingBreak)) {
      open.endedAt = this.lastAt;
      open.closedBy ??= this.pendingBreak ?? "signal-loss";
    }
    this.pendingBreak = null;
    const seg: TrackSegment = {
      index: this.segments.length,
      startedAt: t,
      endedAt: null,
      pointCount: 0,
      distanceM: 0,
      closedBy: null,
    };
    this.segments.push(seg);
    return seg;
  }

  /**
   * Halve stored resolution, keeping each segment's first and last point so no
   * segment collapses and no drawn line loses an endpoint. Stats are untouched
   * — they were accumulated at ingest — so the traverse stays the length it was.
   */
  private thin(): void {
    const kept: TrackPoint[] = [];
    const n = this.points.length;
    for (let i = 0; i < n; i++) {
      const p = this.points[i];
      const isSegmentStart = i === 0 || this.points[i - 1].segment !== p.segment;
      const isSegmentEnd = i === n - 1 || this.points[i + 1].segment !== p.segment;
      if (isSegmentStart || isSegmentEnd || i % 2 === 0) kept.push(p);
    }
    this.points = kept;
    this.thinCount++; // widens movementGate(), so the next fill takes twice as long
  }

  private reject(reason: RejectReason): IngestResult {
    this.rejected[reason]++;
    return { accepted: false, reason };
  }

  // ── Read side (mirrors the Phase 1 controller: subscribe + stable snapshot) ─
  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  getPoints(): readonly TrackPoint[] { return this.points; }
  getSegments(): readonly TrackSegment[] { return this.segments; }
  isRecording(): boolean { return this.recording; }

  getStats(): TrackStats {
    return {
      distanceM: this.distanceM,
      durationMs: this.firstAt != null && this.lastAt != null ? this.lastAt - this.firstAt : 0,
      movingMs: this.movingMs,
      ascentM: this.ascentM,
      descentM: this.descentM,
      pointsAccepted: this.pointsAccepted,
      pointsStored: this.points.length,
      rejected: { ...this.rejected },
      segments: this.segments.length,
      resolutionM: this.config.minDistanceM * 2 ** this.thinCount,
      thinCount: this.thinCount,
      bounds: this.bounds ? { ...this.bounds } : null,
      firstAt: this.firstAt,
      lastAt: this.lastAt,
    };
  }

  /** Stable between mutations, so it can back useSyncExternalStore directly. */
  getSnapshot(): TrackSnapshot {
    this.snapshotCache ??= {
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      recording: this.recording,
      points: this.points,
      segments: this.segments,
      stats: this.getStats(),
    };
    return this.snapshotCache;
  }

  private invalidate(): void {
    this.snapshotCache = null;
    for (const l of this.listeners) l();
  }
}

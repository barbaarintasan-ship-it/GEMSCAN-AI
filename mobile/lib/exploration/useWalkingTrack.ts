// The walking track, recorded for the map.
//
// Deliberately in the UI layer, not in the exploration engine. The engine's job
// is to decide where to go; a breadcrumb of where someone has already been is a
// display concern, and threading it through the engine would mean changing a
// piece of the system that is working. This hook watches the same positions the
// screen already receives and feeds them to the existing TrackRecorder — the
// tested one, with its movement gate, segment breaks and thinning — rather than
// accumulating a second, dumber copy of the same idea.
import { useEffect, useMemo, useRef, useState } from "react";
import { TrackRecorder, type TrackStats } from "../field/trackRecorder";

export interface WalkingTrack {
  /** [lng, lat] pairs, in walking order, ready for the map. */
  points: Array<[number, number]>;
  /** Ground actually covered, from the recorder's own accumulated stats. */
  distanceM: number;
  /**
   * The recorder's full accumulated stats — duration, moving time, relief.
   *
   * Passed straight through rather than recomputed from `points`: the recorder
   * accumulates at ingest precisely so that thinning stored points later cannot
   * shrink the traverse someone actually walked.
   */
  stats: TrackStats;
  /**
   * Metres per second averaged over MOVING time, and the fastest sustained
   * pace seen. Null until there is enough of a track to divide by.
   *
   * Average excludes standing time — a traverse with an hour spent logging an
   * outcrop did not happen at half speed, and reporting that it did would make
   * the number useless for planning the next leg.
   */
  averageSpeedMps: number | null;
  maxSpeedMps: number | null;
}

export function useWalkingTrack(
  position: {
    lat: number; lng: number;
    accuracyM: number | null;
    altitudeM: number | null;
    timestamp: number;
  } | null,
  sessionId: string | null,
): WalkingTrack {
  const recorder = useMemo(() => new TrackRecorder(), []);
  const [version, setVersion] = useState(0);
  const started = useRef<string | null>(null);
  // Peak pace, held here rather than in the recorder: the recorder's job is to
  // decide what is a real movement and what is GPS noise, and it already
  // rejects anything above maxSpeedMps as a spike. What survives that gate is
  // travel, so the fastest of it is a fact about the traverse, not about the
  // receiver — and it is only ever read from ACCEPTED points for that reason.
  const peak = useRef(0);

  useEffect(() => {
    if (!sessionId) {
      // Session over: the track belongs to that session and must not bleed into
      // the next one as a phantom walk the geologist never took.
      if (started.current) {
        recorder.reset(); started.current = null; peak.current = 0; setVersion((v) => v + 1);
      }
      return;
    }
    if (started.current !== sessionId) {
      recorder.reset();
      recorder.begin(sessionId);
      started.current = sessionId;
      peak.current = 0;
    }
  }, [sessionId, recorder]);

  useEffect(() => {
    if (!position || !started.current) return;
    const before = recorder.getStats();
    const r = recorder.addFix({
      lat: position.lat,
      lng: position.lng,
      accuracy: position.accuracyM,
      // Real altitude and timestamp now that the snapshot carries them. Passing
      // nulls here was quietly costing the traverse its ascent and descent — the
      // recorder computes relief, it just had nothing to compute it from.
      altitude: position.altitudeM,
      speed: null,
      timestamp: position.timestamp,
      // The screen only ever publishes real fixes; a cached last-known position
      // is filtered upstream, and the recorder rejects provisional ones anyway.
      provisional: false,
    });
    // Redraw only when a point was actually kept. The recorder rejects fixes
    // that have not moved far enough to matter, and re-rendering the map for a
    // rejected fix would be a repaint per GPS tick for no visible change.
    if (!r.accepted) return;
    const after = recorder.getStats();
    const dtMs = after.movingMs - before.movingMs;
    if (r.movedM > 0 && dtMs > 0) {
      const mps = r.movedM / (dtMs / 1000);
      if (mps > peak.current) peak.current = mps;
    }
    setVersion((v) => v + 1);
  }, [position, recorder]);

  return useMemo(() => {
    void version;
    const pts = recorder.getPoints();
    const stats = recorder.getStats();
    return {
      points: pts.map((p) => [p.lng, p.lat] as [number, number]),
      distanceM: stats.distanceM,
      stats,
      averageSpeedMps: stats.movingMs > 0 ? stats.distanceM / (stats.movingMs / 1000) : null,
      maxSpeedMps: peak.current > 0 ? peak.current : null,
    };
  }, [recorder, version]);
}

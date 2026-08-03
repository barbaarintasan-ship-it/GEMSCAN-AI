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
import { TrackRecorder } from "../field/trackRecorder";

export interface WalkingTrack {
  /** [lng, lat] pairs, in walking order, ready for the map. */
  points: Array<[number, number]>;
  /** Ground actually covered, from the recorder's own accumulated stats. */
  distanceM: number;
}

export function useWalkingTrack(
  position: { lat: number; lng: number; accuracyM: number | null } | null,
  sessionId: string | null,
): WalkingTrack {
  const recorder = useMemo(() => new TrackRecorder(), []);
  const [version, setVersion] = useState(0);
  const started = useRef<string | null>(null);

  useEffect(() => {
    if (!sessionId) {
      // Session over: the track belongs to that session and must not bleed into
      // the next one as a phantom walk the geologist never took.
      if (started.current) { recorder.reset(); started.current = null; setVersion((v) => v + 1); }
      return;
    }
    if (started.current !== sessionId) {
      recorder.reset();
      recorder.begin(sessionId);
      started.current = sessionId;
    }
  }, [sessionId, recorder]);

  useEffect(() => {
    if (!position || !started.current) return;
    const r = recorder.addFix({
      lat: position.lat,
      lng: position.lng,
      accuracy: position.accuracyM,
      altitude: null,
      speed: null,
      timestamp: Date.now(),
      // The screen only ever publishes real fixes; a cached last-known position
      // is filtered upstream, and the recorder rejects provisional ones anyway.
      provisional: false,
    });
    // Redraw only when a point was actually kept. The recorder rejects fixes
    // that have not moved far enough to matter, and re-rendering the map for a
    // rejected fix would be a repaint per GPS tick for no visible change.
    if (r.accepted) setVersion((v) => v + 1);
  }, [position, recorder]);

  return useMemo(() => {
    void version;
    const pts = recorder.getPoints();
    return {
      points: pts.map((p) => [p.lng, p.lat] as [number, number]),
      distanceM: recorder.getStats().distanceM,
    };
  }, [recorder, version]);
}

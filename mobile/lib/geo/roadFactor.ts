// How much further the road is than the straight line.
//
// WHY THIS EXISTS. The app told a geologist a target was "94.4 km · 2 h 42 min".
// The 94.4 km was correct — a geodesic distance, computed properly. The travel
// time was computed from it at 35 km/h, and you cannot drive a straight line.
// Their odometer said 260 km for a round trip whose straight-line leg was
// 64.49 km: a road factor of 2.02. So the real journey to that target was about
// 190 km and five hours, not two and a half.
//
// The code's own comment already knew the stakes: "An estimate that flatters the
// journey is worse than none: someone plans a return trip around it." It
// flattered it by two and a half hours, in the dark, 130 km from anywhere.
//
// WHAT THIS IS NOT. It is not a route. The pack carries faults and geology and no
// roads at all, so nothing on this device can trace a road — and the imagery's
// roads are pixels, not geometry. This is an honest MULTIPLIER, and every number
// derived from it must be labelled as an estimate. A labelled estimate is honest;
// an estimate dressed as a route is a lie (Field Reliability Contract, clause 4).
//
// WHY IT IS MEASURED RATHER THAN ASSUMED. Terrain differs. The Karkaar mountains
// are not the Nugaal plain. The app already records traverses, so it can measure
// the factor for the ground the geologist actually drives — but only when the
// measurement is unambiguous. See `measureFrom`.
import type { KeyValueAdapter } from "../samples/localSampleStore";

/**
 * Used until this device has measured its own ground.
 *
 * 2.0 is the Karkaar figure (130 km of road for 64.49 km of straight line),
 * rounded down. Documented rather than tuned: a default nobody can trace is how
 * a guess becomes folklore.
 */
export const DEFAULT_ROAD_FACTOR = 2.0;

/** A road cannot be shorter than the straight line, and 4x is off the map. */
export const MIN_ROAD_FACTOR = 1.0;
export const MAX_ROAD_FACTOR = 4.0;

/**
 * Journeys shorter than this teach nothing about roads.
 *
 * Below a few kilometres the track is mostly someone walking around an outcrop,
 * which would drive the factor to absurd values — a 200 m displacement with 3 km
 * of wandering is not a road factor of 15.
 */
export const MIN_MEASURABLE_DISPLACEMENT_M = 5_000;

/** Measurements kept. The median of these is the factor. */
export const KEEP_MEASUREMENTS = 12;

export interface RoadMeasurement {
  factor: number;
  /** Straight-line metres from the start to the furthest point reached. */
  displacementM: number;
  at: number;
  /** True when the traverse came back to where it started. */
  returned: boolean;
}

export const ROAD_FACTOR_STORAGE_KEY = "geo.roadFactor.v1";

/**
 * Turn one finished traverse into a road factor, or refuse to.
 *
 * THE AMBIGUITY THIS RESOLVES. Track distance alone cannot be compared with
 * displacement, because a there-and-back journey ends where it began: 260 km of
 * driving over a 64 km straight line is a factor of 2, not 4. So the shape of the
 * traverse has to be classified first, and when it cannot be, nothing is
 * recorded. A wrong factor is worse than the documented default, because it
 * carries the authority of a measurement.
 */
export function measureFrom(input: {
  /** Metres actually travelled, from the track recorder's own accumulator. */
  trackDistanceM: number;
  /** Straight-line metres from the start to the furthest point reached. */
  maxDisplacementM: number;
  /** Straight-line metres from the start to where the traverse ended. */
  endDisplacementM: number;
  at: number;
}): RoadMeasurement | null {
  const { trackDistanceM, maxDisplacementM, endDisplacementM, at } = input;
  if (!Number.isFinite(trackDistanceM) || !Number.isFinite(maxDisplacementM)) return null;
  if (maxDisplacementM < MIN_MEASURABLE_DISPLACEMENT_M) return null;

  // Came back: the road travelled ONE way is about half the odometer.
  const returned = endDisplacementM < maxDisplacementM * 0.25;
  const oneWayRoadM = returned ? trackDistanceM / 2 : trackDistanceM;

  // Ended far from the start but not at the furthest point — a wandering,
  // multi-leg shape. `trackDistanceM` is then not one road and cannot be split
  // honestly, so it teaches nothing.
  if (!returned && endDisplacementM < maxDisplacementM * 0.75) return null;

  const raw = oneWayRoadM / maxDisplacementM;
  if (!Number.isFinite(raw) || raw < MIN_ROAD_FACTOR || raw > MAX_ROAD_FACTOR) return null;

  return { factor: raw, displacementM: maxDisplacementM, at, returned };
}

interface Envelope {
  version: 1;
  measurements: RoadMeasurement[];
}

function createAsyncStorageAdapter(): KeyValueAdapter {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const AsyncStorage = require("@react-native-async-storage/async-storage").default;
  return {
    getItem: (k: string) => AsyncStorage.getItem(k) as Promise<string | null>,
    setItem: (k: string, v: string) => AsyncStorage.setItem(k, v) as Promise<void>,
  };
}

export class RoadFactorStore {
  private measurements: RoadMeasurement[] = [];
  private loaded = false;
  /** The single in-flight read, shared by every caller. */
  private loading: Promise<void> | null = null;
  private storage: KeyValueAdapter;
  private listeners = new Set<() => void>();

  constructor(deps: { storage?: KeyValueAdapter } = {}) {
    this.storage = deps.storage ?? createAsyncStorageAdapter();
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /**
   * Read storage once, and make every caller wait for the SAME read.
   *
   * THE BUG THIS FIXES, because it cost an expedition. `loaded` was set to true
   * BEFORE the await, so the second caller in a tick saw `true` and returned from
   * a read that had not finished — with the collection still empty. In the app the
   * route's hook always won that race and the exploration provider always lost, so
   * the stored lease was invisible at startup and a walk interrupted by a process
   * kill could not be resumed: the phone had the lease on disk and reported no
   * expedition. Four launches in a row, reproducible.
   *
   * The same shape was in five stores, and in three of them it is worse than a
   * lost lease: `add()` awaits `load()` and then persists, so a write landing
   * inside that window would have overwritten every unsent record on disk with
   * one entry. That is the byte-loss path the Field Reliability Contract exists to
   * forbid, and it was reachable.
   *
   * `loaded` is now set in a `finally` after the read genuinely completes, and the
   * in-flight promise is shared.
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loading ??= this.readOnce();
    await this.loading;
  }

  private async readOnce(): Promise<void> {
    try {
      const raw = await this.storage.getItem(ROAD_FACTOR_STORAGE_KEY);
      if (raw) {
        const env = JSON.parse(raw) as Envelope;
        if (env?.version === 1 && Array.isArray(env.measurements)) {
          this.measurements = env.measurements.filter(
            (m) => typeof m?.factor === "number" && m.factor >= MIN_ROAD_FACTOR && m.factor <= MAX_ROAD_FACTOR,
          );
        }
      }
    } catch {
      // Unreadable history is the same as none: the documented default applies.
    } finally {
      this.loaded = true;
      for (const l of this.listeners) l();
    }
  }

  async record(m: RoadMeasurement): Promise<void> {
    await this.load();
    this.measurements = [...this.measurements, m].slice(-KEEP_MEASUREMENTS);
    try {
      const env: Envelope = { version: 1, measurements: this.measurements };
      await this.storage.setItem(ROAD_FACTOR_STORAGE_KEY, JSON.stringify(env));
    } catch {
      // In memory for this session; the next write may land.
    }
    for (const l of this.listeners) l();
  }

  /**
   * The factor in force.
   *
   * MEDIAN, not mean: one strange traverse — a ferry, a closed road, a day spent
   * driving in circles — should not move the number the geologist plans around.
   */
  current(): number {
    if (this.measurements.length === 0) return DEFAULT_ROAD_FACTOR;
    const xs = this.measurements.map((m) => m.factor).sort((a, b) => a - b);
    const mid = Math.floor(xs.length / 2);
    return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
  }

  /** Whether the factor is measured or still the documented default. */
  isMeasured(): boolean {
    return this.measurements.length > 0;
  }

  count(): number { return this.measurements.length; }
  all(): readonly RoadMeasurement[] { return this.measurements; }
}

let instance: RoadFactorStore | null = null;

export function roadFactor(): RoadFactorStore {
  instance ??= new RoadFactorStore();
  return instance;
}

/** Tests only. */
export function __setRoadFactorForTests(s: RoadFactorStore | null): void {
  instance = s;
}

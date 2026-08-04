// The upgrade's central claim, in tests: DISTANCE CLASSIFIES A TARGET, IT NEVER
// CANCELS ONE.
//
// The screen used to finish on "nothing to walk to here" while the knowledge
// pack held a mapped gold occurrence 94 km to the south-west. Every test below
// exists to stop that sentence coming back — in the wording, in the formatting,
// or in the engine deciding a real record is not worth mentioning.
//
// These are pure: the formatters take a `t`, the layer merge takes a plain
// object, and neither touches a sensor or the network.
// Two modules under test reach a native module at import time — AsyncStorage
// for the layer preferences, expo-file-system/sharing for the export. What is
// being tested in both cases is the pure decision above that boundary (which
// keys survive a merge, which waypoints would actually be written), so the
// native side is stubbed rather than the tests being skipped.
jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: { getItem: jest.fn(async () => null), setItem: jest.fn(async () => {}) },
}));
jest.mock("expo-file-system", () => ({
  cacheDirectory: "/tmp/", writeAsStringAsync: jest.fn(), EncodingType: { UTF8: "utf8" },
}));
jest.mock("expo-sharing", () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));

import {
  compassKey, confidenceBandKey, describeClass, distanceBandKey, formatDistance,
  formatDuration, formatElevationDelta, formatFixAge, formatSpeed, formatTravel,
  transportKey, transportShortKey,
} from "../exploration/format";
import { classifyDistance } from "../geo/expedition";
import { mergeLayers } from "../geo/layerPrefs";
import { gradeFix, arrivalRadiusFor, POOR_ACCURACY_M, STALE_FIX_MS } from "../geo/fixQuality";
import { exportableCount } from "../field/waypointShare";
import type { Waypoint } from "../field/waypointTypes";

/**
 * A fake `t` that echoes its key and interpolations.
 *
 * Deliberately not the real i18n instance: what is under test is WHICH key a
 * number is rendered through and with what values, not the English wording,
 * which the locale files own and which must be free to change.
 */
const t = (k: string, o?: Record<string, unknown>): string =>
  o ? `${k}(${Object.entries(o).map(([a, b]) => `${a}=${String(b)}`).join(",")})` : k;

describe("travel time is stated at the granularity it deserves", () => {
  test("minutes below the hour", () => {
    expect(formatTravel(t, 45)).toBe("field.travel.minutes(value=45)");
  });

  test("hours and minutes below the day", () => {
    expect(formatTravel(t, 160)).toBe("field.travel.hoursMinutes(h=2,m=40)");
    expect(formatTravel(t, 120)).toBe("field.travel.hours(value=2)");
  });

  // A two-day drive reported as "48 h" reads like a schedule someone could keep.
  test("whole days beyond a day, never a large hour count", () => {
    expect(formatTravel(t, 60 * 40)).toBe("field.travel.days(value=2)");
  });

  test("a journey that cannot be estimated says so rather than guessing", () => {
    expect(formatTravel(t, null)).toBe("field.travel.unknown");
    expect(formatTravel(t, NaN)).toBe("field.travel.unknown");
  });

  // Rounding a 20-second walk to "0 min" reads as "you are already there".
  test("anything non-zero is at least one minute", () => {
    expect(formatTravel(t, 0.3)).toBe("field.travel.minutes(value=1)");
  });
});

describe("distance classifies rather than rejects", () => {
  test("every band is reachable and every band names its transport", () => {
    const cases: Array<[number, string, string]> = [
      [200, "immediate", "walk"],
      [3_000, "local", "walk_or_drive"],
      [30_000, "regional", "vehicle"],
      [94_000, "expedition", "expedition"],
    ];
    for (const [m, band, transport] of cases) {
      const c = classifyDistance(m);
      expect(c.band).toBe(band);
      expect(c.transport).toBe(transport);
      // The one thing that must never happen: a real distance producing no
      // travel estimate, which is how a target becomes un-navigable.
      expect(c.travelMinutes).toBeGreaterThan(0);
    }
  });

  test("the 94 km case renders as a drive, not as a refusal", () => {
    const c = classifyDistance(94_000);
    // 94 km at 35 km/h ≈ 161 min ≈ 2 h 41 min.
    expect(formatTravel(t, c.travelMinutes)).toBe("field.travel.hoursMinutes(h=2,m=41)");
    expect(describeClass(t, c)).toContain("field.bandDistance.expedition");
    expect(describeClass(t, c)).toContain("field.transport.expedition");
  });

  test("band and transport keys are namespaced apart from CONFIDENCE bands", () => {
    // These two were the same word in the old UI and mean entirely different
    // things: how far away a target is, versus how sure the engine is about it.
    expect(distanceBandKey("regional")).toBe("field.bandDistance.regional");
    expect(confidenceBandKey("High")).toBe("field.band.High");
    expect(transportKey("vehicle")).toBe("field.transport.vehicle");
    expect(transportShortKey("vehicle")).toBe("field.transportShort.vehicle");
    expect(compassKey("SW")).toBe("field.compass.SW");
  });
});

describe("distances stay readable at expedition range", () => {
  test("metres below a kilometre, kilometres above", () => {
    expect(formatDistance(t, 450)).toBe("field.distance.m(value=450)");
    expect(formatDistance(t, 1_480)).toBe("field.distance.km(value=1.5)");
    expect(formatDistance(t, 1_000)).toBe("field.distance.km(value=1.0)");
  });

  // "94.0 km" is a false decimal: the fix it was measured from is not that good.
  test("a hundred kilometres and beyond drops the decimal", () => {
    expect(formatDistance(t, 94_000)).toBe("field.distance.km(value=94.0)");
    expect(formatDistance(t, 240_000)).toBe("field.distance.km(value=240)");
  });
});

describe("elevation difference is never invented", () => {
  test("no DEM covering both points is 'unknown', not 'level'", () => {
    expect(formatElevationDelta(t, null)).toBe("field.target.elevationUnknown");
  });

  test("small differences read as level rather than as false precision", () => {
    expect(formatElevationDelta(t, 4)).toBe("field.target.elevationSame");
  });

  test("up and down are distinct, and down is reported as a positive climb down", () => {
    expect(formatElevationDelta(t, 180)).toBe("field.target.elevationUp(m=180)");
    expect(formatElevationDelta(t, -180)).toBe("field.target.elevationDown(m=180)");
  });
});

describe("the GPS readout claims only what the receiver reported", () => {
  test("a tight fix is good and unwarned; a loose one warns", () => {
    expect(gradeFix({ accuracyM: 6, timestamp: 1_000 }, 1_000).grade).toBe("good");
    const poor = gradeFix({ accuracyM: POOR_ACCURACY_M + 20, timestamp: 1_000 }, 1_000);
    expect(poor.grade).toBe("poor");
    expect(poor.warn).toBe(true);
  });

  // A precise position for somewhere you left is worse than an imprecise one
  // for where you are, so age is judged before accuracy.
  test("a stale fix is stale however accurate it was", () => {
    const g = gradeFix({ accuracyM: 3, timestamp: 0 }, STALE_FIX_MS + 1);
    expect(g.grade).toBe("stale");
    expect(g.warn).toBe(true);
  });

  test("an unreported accuracy is not treated as a good one", () => {
    expect(gradeFix({ accuracyM: null, timestamp: 1_000 }, 1_000).grade).toBe("usable");
  });

  test("no fix at all warns rather than showing a dot somewhere", () => {
    const g = gradeFix(null);
    expect(g.grade).toBe("none");
    expect(g.accuracyM).toBeNull();
    expect(g.warn).toBe(true);
  });

  test("arrival tightens with a good fix and is capped for a terrible one", () => {
    expect(arrivalRadiusFor(4)).toBe(25);
    expect(arrivalRadiusFor(400)).toBe(150);
  });

  test("fix age is stated, and only a truly fresh fix reads as 'just now'", () => {
    expect(formatFixAge(t, 500)).toBe("field.gps.updatedJustNow");
    expect(formatFixAge(t, 12_000)).toBe("field.gps.updatedSeconds(s=12)");
    expect(formatFixAge(t, 180_000)).toBe("field.gps.updatedMinutes(m=3)");
  });
});

describe("traverse figures", () => {
  test("speed is reported in km/h, and no movement reports nothing", () => {
    expect(formatSpeed(t, 1.4)).toBe("field.track.speed(value=5.0)");
    expect(formatSpeed(t, null)).toBe("field.track.none");
    expect(formatSpeed(t, 0)).toBe("field.track.none");
  });

  test("duration shares the travel-time rule, so the two can never disagree", () => {
    expect(formatDuration(t, 45 * 60_000)).toBe("field.travel.minutes(value=45)");
    expect(formatDuration(t, 0)).toBe("field.track.none");
  });
});

describe("layer preferences survive a new layer being added", () => {
  // The regression this guards: shipping `grid` would have read as "off" for
  // every existing user, because their stored blob predates the key.
  test("a key the stored set never heard of falls back to its default", () => {
    const defaults = { satellite: true, geology: true, grid: true };
    const stored = { satellite: false, geology: true };
    expect(mergeLayers(defaults, stored)).toEqual({ satellite: false, geology: true, grid: true });
  });

  test("a stored key that no longer exists is dropped, not carried", () => {
    expect(mergeLayers({ satellite: true }, { satellite: true, hillshade: true }))
      .toEqual({ satellite: true });
  });

  test("unreadable preferences fall back rather than failing a field session", () => {
    const defaults = { satellite: true };
    expect(mergeLayers(defaults, null)).toBe(defaults);
    expect(mergeLayers(defaults, "corrupt")).toBe(defaults);
    // A non-boolean is not a layer state and must not be coerced into one.
    expect(mergeLayers(defaults, { satellite: "no" })).toEqual({ satellite: true });
  });
});

describe("export counts what would actually be written", () => {
  const wp = (over: Partial<Waypoint>): Waypoint => ({
    id: "w", type: "outcrop", name: null, notes: null,
    capturedAt: 0, position: { lat: 1, lng: 2, accuracyM: 5, altitudeM: null },
    headingDeg: null, photos: [], trackId: null, deletedAt: null,
    ...over,
  } as Waypoint);

  test("only positioned, undeleted waypoints count", () => {
    expect(exportableCount([
      wp({ id: "a" }),
      wp({ id: "b", position: null }),          // never got a fix
      wp({ id: "c", deletedAt: 1 }),            // removed by the geologist
    ])).toBe(1);
  });
});

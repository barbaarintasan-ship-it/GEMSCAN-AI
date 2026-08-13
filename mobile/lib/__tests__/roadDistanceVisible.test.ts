// Is the road distance actually ON THE SCREEN?
//
// The multiplier was implemented, unit-tested and shipped, and the geologist
// said: "intaan ma arko 174 km waddo". They were right to. It had been wired
// into exactly one statistic in the expanded sheet, while the four surfaces they
// actually read — the pill above the map, its subtitle, the recommendation
// sentence and the band line — all still printed a straight-line distance next
// to a driving time computed from the road.
//
// So these tests do NOT use a key-echoing `t`. They render through the REAL
// locale bundles, because the defect was never in the arithmetic: 86.2 km was
// correct, 172 km was correct, and neither fact reached the reader. A test that
// asserts a key was chosen cannot catch a template that drops the value.
//
// The invariant at the centre of the file is this: NO TRAVEL TIME IS PUBLISHED
// WITHOUT THE DISTANCE IT WAS COMPUTED FROM. That is the failure of 7–8 August
// 2026 stated as something a machine can check.
// `recommendation()` reads the device's measured factor from the road-factor
// singleton, which reaches AsyncStorage at construction. Stubbed empty on
// purpose: with nothing measured the store returns the documented default, which
// is the state a fresh phone is in and therefore the state worth asserting.
jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: { getItem: jest.fn(async () => null), setItem: jest.fn(async () => {}) },
}));

import so from "../../locales/so.json";
import en from "../../locales/en.json";
import { describeClass, formatRoadDistance, roadClause, type TFunc } from "../exploration/format";
import { recommendation } from "../exploration/wording";
import { classifyDistance, type RegionalTarget } from "../geo/expedition";
import type { ExplorationSnapshot } from "../exploration/orchestrator";

/** The real bundle, interpolated the way i18next interpolates it. */
function realT(bundle: Record<string, unknown>): TFunc {
  return ((key: string, vars?: Record<string, unknown>) => {
    const found = key.split(".").reduce<unknown>(
      (o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
      bundle,
    );
    if (typeof found !== "string") throw new Error(`missing locale key: ${key}`);
    return found.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
      const v = vars?.[name];
      return v == null ? "" : String(v);
    });
  }) as TFunc;
}

const soT = realT(so as unknown as Record<string, unknown>);
const enT = realT(en as unknown as Record<string, unknown>);

/** Every leaf string in a bundle, with its dotted path. */
function leaves(o: Record<string, unknown>, prefix = ""): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "string") out.push([prefix + k, v]);
    else if (v && typeof v === "object") out.push(...leaves(v as Record<string, unknown>, `${prefix}${k}.`));
  }
  return out;
}

// The Karkaar target, as the phone had it: 86.2 km of straight line, and a road
// the odometer measured at about twice that.
const KARKAAR_M = 86_200;
const FACTOR = 2.0;

describe("the contract: a travel time never travels alone", () => {
  for (const [name, bundle] of [["so", so], ["en", en]] as const) {
    test(`${name}: every string that quotes a travel time also quotes the road`, () => {
      const offenders = leaves(bundle as unknown as Record<string, unknown>)
        .filter(([, v]) => v.includes("{{travel}}") && !v.includes("{{road}}"))
        .map(([k]) => k);
      // A template with {{travel}} and no {{road}} is the 7 August screen: a
      // duration derived from a road, printed beside a straight line.
      expect(offenders).toEqual([]);
    });
  }

  test("both locales carry the road strings, so neither falls back to a raw key", () => {
    for (const b of [so, en] as const) {
      const d = (b as unknown as { field: { distance: Record<string, string> } }).field.distance;
      expect(typeof d.roadShort).toBe("string");
      expect(typeof d.roadEstimate).toBe("string");
      expect(d.roadEstimate).toContain("{{road}}");
      expect(d.roadEstimate).toContain("{{factor}}");
    }
  });
});

describe("the pill above the map", () => {
  test("it names the road distance in kilometres a person can read", () => {
    const cls = classifyDistance(KARKAAR_M, FACTOR);
    const short = formatRoadDistance(soT, cls.travelDistanceM, cls.roadFactorApplied);
    expect(short).toBe("~172 km waddo");
    expect(formatRoadDistance(enT, cls.travelDistanceM, cls.roadFactorApplied)).toBe("~172 km by road");
  });

  test("it stays short enough for one line", () => {
    const cls = classifyDistance(KARKAAR_M, FACTOR);
    const subtitle = `${formatRoadDistance(soT, cls.travelDistanceM, cls.roadFactorApplied)} · 4 saac 19 daqiiqo`;
    // The pill clips at one line (numberOfLines={1}, 78% width, 12px). Past ~40
    // characters the number disappears, which is the bug this file is about.
    expect(subtitle.length).toBeLessThanOrEqual(40);
  });

  test("on foot there is no road figure, because there is no road", () => {
    const cls = classifyDistance(900, FACTOR);
    expect(cls.roadFactorApplied).toBe(1);
    expect(formatRoadDistance(soT, cls.travelDistanceM, cls.roadFactorApplied)).toBeNull();
    expect(roadClause(soT, cls.travelDistanceM, cls.roadFactorApplied)).toBe("");
  });
});

describe("the band line under a target", () => {
  test("it carries the road distance and the multiplier it used", () => {
    const line = describeClass(soT, classifyDistance(KARKAAR_M, FACTOR));
    expect(line).toContain("172 km waddo");
    expect(line).toContain("×2.0");
  });

  test("a walk reads exactly as it did before — no clause, no stray separator", () => {
    const line = describeClass(soT, classifyDistance(900, FACTOR));
    expect(line).not.toContain("waddo");
    expect(line).not.toMatch(/ · +·/);
  });
});

describe("the sentence the geologist reads first", () => {
  const base = {
    state: "idle", suspendedBy: null, inspecting: null, activeTarget: null,
    destination: null, destinationDistanceM: null, destinationBearingDeg: null,
  } as unknown as ExplorationSnapshot;

  const nearest = {
    id: "x", kind: "occurrence", label: "Macdan", commodity: "gold",
    lat: 11.5, lng: 49.5, distanceM: KARKAAR_M, bearingDeg: 0, compass: "N",
    distanceClass: classifyDistance(KARKAAR_M, FACTOR), priority: 0.5,
  } as unknown as RegionalTarget;

  test("the nearest-mapped-ground sentence states both distances and the basis", () => {
    const s = recommendation(base, null, nearest, soT);
    expect(s).toContain("86.2 km");        // measured, straight line
    expect(s).toContain("172 km waddo");   // what will actually be driven
    expect(s).toContain("×2.0");           // and on whose authority
  });

  test("a chosen destination says the same thing", () => {
    const withDest = {
      ...base,
      destination: { lat: 11.5, lng: 49.5 },
      destinationDistanceM: KARKAAR_M,
      destinationBearingDeg: 0,
    } as unknown as ExplorationSnapshot;
    const s = recommendation(withDest, null, null, soT);
    expect(s).toContain("172 km waddo");
    expect(s).toContain("×2.0");
  });

  test("English says it too", () => {
    expect(recommendation(base, null, nearest, enT)).toContain("172 km by road");
  });

  test("a target inside walking range is not dressed up as a drive", () => {
    const close = {
      ...nearest,
      distanceM: 900,
      distanceClass: classifyDistance(900, FACTOR),
    } as unknown as RegionalTarget;
    expect(recommendation(base, null, close, soT)).not.toContain("waddo");
  });
});

describe("the guard the locale check could not provide", () => {
  // The travel line under a regional lead was assembled in JSX — transport, then
  // duration, then priority — so it never passed through a template and the
  // locale invariant above could not see it. On the phone it read
  // "177 km  waqooyi · Safar · 8 saac 50 daqiiqo": a straight line beside a road
  // time, which is the original defect, in a different component.
  //
  // This reads the source. Any file that prints a raw duration must also print
  // the distance it came from.
  test("no screen prints a travel time without also printing the road distance", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs") as typeof import("fs");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require("path") as typeof import("path");
    const root = path.resolve(__dirname, "../..");

    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (["node_modules", "android", "ios", ".expo", "__tests__"].includes(e.name)) continue;
          walk(full);
        } else if (/\.tsx?$/.test(e.name)) files.push(full);
      }
    };
    for (const d of ["app", "components", "lib"]) walk(path.join(root, d));

    const offenders = files.filter((f) => {
      // format.ts is where the basis is ATTACHED, so it is the one legitimate
      // caller of the bare duration formatter.
      if (f.endsWith(path.join("lib", "exploration", "format.ts"))) return false;
      const src = fs.readFileSync(f, "utf8");
      if (!src.includes("formatTravel(")) return false;
      return !/formatRoadDistance\(|roadClause\(|formatTravelDistance\(|roadOf\(/.test(src);
    }).map((f) => path.relative(root, f));

    expect(offenders).toEqual([]);
  });
});

describe("the two locales say the same thing", () => {
  // The Somali speed reading was "socod 14.3 km/s" while English said "km/h".
  // The number was correct — km/h, as computed — and the unit beside it was
  // wrong by a factor of 3600. Nobody spots that in a review of a JSON file;
  // a machine spots it every run.
  const leaves2 = (o: Record<string, unknown>, p = ""): Array<[string, string]> =>
    Object.entries(o).flatMap(([k, v]) =>
      typeof v === "string"
        ? [[p + k, v] as [string, string]]
        : v && typeof v === "object"
          ? leaves2(v as Record<string, unknown>, `${p}${k}.`)
          : []);

  const S = new Map(leaves2(so as unknown as Record<string, unknown>));
  const E = new Map(leaves2(en as unknown as Record<string, unknown>));

  test("every key exists in both, so nothing falls back to a raw key on screen", () => {
    expect([...E.keys()].filter((k) => !S.has(k))).toEqual([]);
    expect([...S.keys()].filter((k) => !E.has(k))).toEqual([]);
  });

  test("compound units match — a translation may not change what is measured", () => {
    // PHYSICAL unit symbols only. "scans/day" is a pair of words that Somali
    // renders as "iskaan maalintii" — a translation, not a change of unit.
    const units = (v: string) => (v.match(/\b(?:mm|cm|m|km)\/(?:s|h|min|d)\b/g) ?? []).sort();
    const mismatched = [...E].filter(([k, ev]) => {
      const sv = S.get(k);
      return sv != null && units(ev).join(",") !== units(sv).join(",");
    }).map(([k]) => k);
    expect(mismatched).toEqual([]);
  });

  test("every interpolation a template needs exists in the other locale too", () => {
    // A dropped {{road}} in one language is the original bug, in one language.
    const vars = (v: string) => (v.match(/\{\{(\w+)\}\}/g) ?? []).sort();
    const mismatched = [...E].filter(([k, ev]) => {
      const sv = S.get(k);
      return sv != null && vars(ev).join(",") !== vars(sv).join(",");
    }).map(([k]) => k);
    expect(mismatched).toEqual([]);
  });
});

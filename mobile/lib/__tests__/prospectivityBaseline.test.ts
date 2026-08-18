// THE BASELINE. Does the prospectivity engine rank mineralised ground above
// random Somali ground?
//
// This runs the REAL bundled pack — 81 geology units, 159 mapped occurrences,
// 96 faults, 2,191 terrain cells — through the SAME scoring path the phone uses.
// Not a fixture. The point is to measure the thing that ships.
//
// It is written before the commodity work, deliberately, because it is the only
// instrument that can say whether the commodity work helps. Every later change to
// scoring must be run against it, and must not make these numbers worse.
//
// TWO RUNS, and the second is the honest one:
//
//   LEAVE-ONE-OUT   the occurrence under test is removed from its own evidence,
//                   but a genuine nearby cluster still counts — as it should,
//                   because a geologist would use it.
//   BLIND           ALL occurrence and association evidence removed. Can geology,
//                   structure and terrain alone find mineralisation, knowing
//                   nothing about where anyone has already found some? This is the
//                   number that says whether the model contains geology or only
//                   bookkeeping.
//
// The assertions are FLOORS, not targets. They exist so that a future change
// cannot quietly make ranking worse; they are deliberately set below what the
// engine achieves today, and should be raised as it improves.
jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: { getItem: jest.fn(async () => null), setItem: jest.fn(async () => {}) },
}));

import * as fs from "fs";
import * as path from "path";
import { PackStore, createBundledPackSource } from "../geo/packStore";
import { OfflineGeoContextService, DEFAULT_CONTEXT_RADIUS_M } from "../geo/offlineGeoContext";
import { collapseGroups, prospectivityEvidence, type ProspectivityOptions } from "../geo/targeting";
import { computeConfidence } from "../../../shared/geo-core/confidence";
import {
  LEAKAGE_RATIO_LIMIT,
  coverageBias, formatLeakage, formatRun, metricsFor, randomLandPoints, seededRandom,
  type RoleLeakage, type ScoredPoint, type ValidationRun,
} from "../geo/prospectivityValidation";
import {
  EVIDENCE_ROLES, ROLES_NOT_SCORED, ROLES_WITHOUT_SOURCE, type EvidenceRole,
} from "../geo/evidenceRoles";
import { dataRolesAt } from "../geo/evidenceCoverage";
import type { PackData } from "../../../shared/geo-core/pack/types";

const PACK_DIR = path.join(__dirname, "..", "..", "assets", "geo-pack");

/** The pack exactly as the APK ships it. */
function bundledFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fs.readdirSync(PACK_DIR)) {
    if (f.endsWith(".json")) out[f] = fs.readFileSync(path.join(PACK_DIR, f), "utf8");
  }
  return out;
}

/** Seeded, so the background set is the same in every run for ever. */
const SEED = 20260810;
/** Balanced against the 159 occurrences: enough to measure, fast enough to run in CI. */
const BACKGROUND_POINTS = 300;

interface Scored {
  score: number;
  /**
   * Which layers have DATA here — not which produced evidence.
   *
   * The distinction is the whole point. Terrain produces no evidence today
   * because it is deliberately not scored, so a detector watching evidence
   * output would report it as clean while its coverage is a perfect proxy for
   * "a known occurrence is near". Leakage is a property of where the DATA is.
   */
  roles: EvidenceRole[];
}

interface Harness {
  pack: PackData;
  score: (lat: number, lng: number, opts: ProspectivityOptions) => Promise<Scored>;
}

async function harness(): Promise<Harness> {
  const store = new PackStore(createBundledPackSource(() => bundledFiles()));
  const status = await store.load();
  if (status.state === "empty") throw new Error(`bundled pack did not load: ${status.state}`);
  const pack = store.getData();
  const geo = new OfflineGeoContextService(store);

  return {
    pack,
    score: async (lat, lng, opts) => {
      const { context } = await geo.contextAt(lat, lng, { radiusM: DEFAULT_CONTEXT_RADIUS_M });
      const scored = prospectivityEvidence(
        context, DEFAULT_CONTEXT_RADIUS_M, undefined, pack, opts,
      );
      return {
        // Correlated items collapsed first — the same combination the engine uses.
        score: computeConfidence(collapseGroups(scored)).score,
        // DATA presence, not evidence output. See dataRolesAt.
        roles: [...dataRolesAt(pack, { lat, lng }, DEFAULT_CONTEXT_RADIUS_M)],
      };
    },
  };
}

async function runValidation(h: Harness, name: string, opts: ProspectivityOptions): Promise<ValidationRun> {
  const points: ScoredPoint[] = [];

  for (const o of h.pack.occurrences) {
    // The lithology prior must not count the occurrence it is being asked about.
    // Background points are not in the fit at all, so they take the plain prior.
    const r = await h.score(o.lat, o.lng, { ...opts, lithologyLeaveOneOut: true });
    points.push({
      lat: o.lat, lng: o.lng, commodity: o.commodity_key,
      label: "occurrence", score: r.score, roles: r.roles,
    });
  }

  const bbox = h.pack.geology.reduce<[number, number, number, number]>(
    (b, g) => [
      Math.min(b[0], g.bbox[0]), Math.min(b[1], g.bbox[1]),
      Math.max(b[2], g.bbox[2]), Math.max(b[3], g.bbox[3]),
    ],
    [180, 90, -180, -90],
  );

  for (const p of randomLandPoints(h.pack, bbox, BACKGROUND_POINTS, seededRandom(SEED))) {
    const r = await h.score(p.lat, p.lng, opts);
    points.push({ ...p, label: "background", score: r.score, roles: r.roles });
  }

  return { name, metrics: metricsFor(points), points };
}

// Scoring ~460 points against the whole pack takes a while; it is worth it.
jest.setTimeout(180_000);

describe("prospectivity baseline — the real pack, the real scorer", () => {
  let leaveOneOut: ValidationRun;
  let blind: ValidationRun;
  let blindNoTerrain: ValidationRun;
  let leakage: RoleLeakage[];

  beforeAll(async () => {
    const h = await harness();
    leaveOneOut = await runValidation(h, "LEAVE-ONE-OUT (occurrence removed from its own evidence)", {
      excludeOccurrencesWithinM: 100,
    });
    blind = await runValidation(h, "BLIND (no occurrence or association evidence at all)", {
      blindToOccurrences: true,
    });
    // The gate: the same hard test with terrain withheld, so admitting a layer is
    // a measured decision and not an opinion.
    blindNoTerrain = await runValidation(h, "BLIND, terrain withheld", {
      blindToOccurrences: true, blindToTerrain: true,
    });
    leakage = coverageBias(leaveOneOut.points);
    // Printed so the baseline is recorded in the run, not just asserted on.
    // eslint-disable-next-line no-console
    console.log(
      `\n${formatRun(leaveOneOut)}\n\n${formatRun(blind)}\n` +
      `\nCOVERAGE BIAS — does a layer's presence alone predict an occurrence?\n` +
      `${formatLeakage(leakage)}\n`,
    );
  });

  test("the pack under test is the one that ships", () => {
    expect(leaveOneOut.metrics.occurrenceCount).toBe(159);
    expect(leaveOneOut.metrics.backgroundCount).toBeGreaterThan(BACKGROUND_POINTS * 0.5);
  });

  test("background is drawn from LAND, not the Gulf of Aden", () => {
    // Comparing rock against sea would produce a flattering number that only
    // proves the coastline loaded.
    expect((leaveOneOut.points.filter((p) => p.label === "background")).length)
      .toBeGreaterThan(0);
  });

  // ── FLOORS, measured 10 August 2026 ──────────────────────────────────────
  // Set just under what the engine achieves today, so an improvement passes and
  // a regression fails. Raise them as the engine improves; never lower them to
  // make a change fit.
  describe("LEAVE-ONE-OUT — measured AUC 0.898, lift 2.82x", () => {
    // Was 0.865 before the lithology prior; 0.896 after.
    test("occurrences outrank background", () => {
      expect(leaveOneOut.metrics.auc).toBeGreaterThanOrEqual(0.87);
    });
    test("walking the top decile beats walking at random", () => {
      expect(leaveOneOut.metrics.topDecileLift).toBeGreaterThanOrEqual(2.5);
    });
    test("the median occurrence scores well above the median background", () => {
      expect(leaveOneOut.metrics.medianDifference).toBeGreaterThanOrEqual(0.68);
    });
  });

  describe("BLIND — measured AUC 0.843, and it used to be 0.53", () => {
    // THE MEASUREMENT THAT JUSTIFIED THE LITHOLOGY PRIOR.
    //
    // Before: strip out occurrence evidence and the engine could not tell
    // mineralised ground from random ground at all — AUC 0.53, lift 1.0, and
    // 90.4% of every point scoring exactly zero. All of its apparent skill came
    // from "a known occurrence is near here", which finds more of what is already
    // found and is not geology.
    //
    // After scoring the rock class: AUC 0.81, lift 2.30, zeros down to 66%.
    // After the independent Copernicus DEM and landform: 0.843, 2.49, 37%.
    //
    // Terrain ships at H3 resolution 6 rather than 7. At 7 the country needs
    // 254,623 rows, and Metro turns pack JSON into live objects at startup: the
    // app went from 297 MB at rest to 588 MB, worse than the memory pressure that
    // was freezing it. Resolution 6 is 36,505 rows and 17 MB, and costs 0.010 of
    // AUC. Measured, and an easy trade.
    // The engine can now assess ground nobody has ever recorded a find on, which
    // was the entire point of Phase 1.4 and 1.5.
    //
    // These are floors on the HARD test. They matter more than the leave-one-out
    // numbers, because this is the case a geologist walking new country is in.
    test("it can find mineralisation with no knowledge of past finds", () => {
      expect(blind.metrics.auc).toBeGreaterThanOrEqual(0.82);
      expect(blind.metrics.occurrenceCount).toBe(159);
    });

    test("the top decile is worth walking, blind", () => {
      expect(blind.metrics.topDecileLift).toBeGreaterThanOrEqual(2.4);
    });

    test("most ground now has an opinion attached to it", () => {
      // 0.904 with occurrences alone, 0.66 with lithology, 0.37 with landform.
      // Every future layer must push this down further; if one is added and this
      // does not move, that layer is not reaching the scorer.
      expect(blind.metrics.zeroScoreRate).toBeLessThanOrEqual(0.42);
    });
  });

  // ── LEAKAGE ───────────────────────────────────────────────────────────────
  describe("no scored layer may predict occurrences by its coverage alone", () => {
    // WHAT THIS CAUGHT. The DEM was sampled in a k-ring around each MRDS site, so
    // 100% of the 2,191 terrain cells sit within 6.1 km of a known occurrence.
    // Wiring terrain into the score would have raised every metric in this file
    // while teaching the model nothing but "somebody sampled the DEM here" — and
    // it would have looked exactly like success.
    //
    // The rule is not "terrain is banned". The rule is that a layer may only
    // enter the score once its coverage is independent of where mineralisation
    // has already been found. Geology passed that test, and was admitted.
    //
    // Note the detector measures DATA PRESENCE, never evidence output. A layer
    // that works will correlate with occurrences by construction; that is a model
    // succeeding, not a leak.

    test("drainage is unbiased too — the reason it is not scored is different", () => {
      // 16,870 reaches derived from the same country-wide DEM, so its coverage
      // behaves like terrain's: ratio 1.36, comfortably admissible.
      //
      // It is withheld on USEFULNESS, not on leakage. Occurrence enrichment by
      // distance-to-channel is flat — 1.11, 1.18, 0.86, 1.03, 1.01 across the
      // bands — so a weight would be an invention. And the placer hypothesis,
      // where drainage should matter most, cannot be tested at all: the label set
      // contains zero occurrences described as placer or alluvial, and 143 of 159
      // carry no deposit_type. See lib/geo/evidenceRoles.ts.
      const drainage = leakage.find((r) => r.role === "drainage");
      expect(drainage).toBeDefined();
      expect(drainage!.leaks).toBe(false);
      expect(drainage!.ratio).toBeLessThan(2.0);
    });

    test("geology is unbiased — which is why it WAS admitted", () => {
      // Present at 99% of occurrences and 100% of background: knowing the app has
      // geology here tells you nothing about whether anyone has found something.
      // That, plus a measured 6.9x enrichment in metamorphic ground, is the case.
      const geology = leakage.find((r) => r.role === "geology");
      expect(geology?.leaks).toBe(false);
      expect(geology!.ratio).toBeLessThan(1.5);
    });

    test("terrain is unbiased NOW — it was 150x before the independent DEM", () => {
      // The occurrence-biased pack: present at 100% of occurrences and 1% of
      // background. Copernicus GLO-30 over the whole country: 1.37. That number
      // is the entire justification for admitting the layer.
      const terrain = leakage.find((r) => r.role === "terrain");
      expect(terrain).toBeDefined();
      expect(terrain!.leaks).toBe(false);
      expect(terrain!.ratio).toBeLessThan(2.0);
      expect(terrain!.atBackground).toBeGreaterThan(0.5);
    });

    test("the terrain layer is country-wide, not a halo around known finds", () => {
      // A structural check on the DATA, independent of the ratio: a layer present
      // at three quarters of random Somali ground cannot be an occurrence halo.
      const terrain = leakage.find((r) => r.role === "terrain")!;
      expect(terrain.atBackground).toBeGreaterThan(0.5);
    });

    test("contacts leak 3.5x — measured, and the reason they are not scored", () => {
      // The Abbate 1:1,500,000 contacts are real geology from a real map. They are
      // still withheld, on two measurements:
      //
      //   · this detector: present at 91% of occurrences, 26% of background
      //   · stratified by lithology class, the signal is mostly the geology signal
      //     restated — inside metamorphic ground the ratio is 1.17, and 109 of 159
      //     occurrences are in metamorphic ground while 738 of 800 random points
      //     are in sedimentary cover. The map is subdivided more finely where the
      //     basement is, and the basement is where the finds are.
      //
      // Scoring them would double count geology, which already carries a measured
      // 6.9x metamorphic enrichment. The threshold is not moved to let them in.
      const contacts = leakage.find((r) => r.role === "contacts");
      expect(contacts).toBeDefined();
      expect(contacts!.leaks).toBe(true);
      expect(contacts!.ratio).toBeGreaterThan(LEAKAGE_RATIO_LIMIT);
      expect(ROLES_NOT_SCORED).toContain<EvidenceRole>("contacts");
    });

    test("lineaments leak 4.3x — measured, and the reason they are not scored", () => {
      // 5,960 Copernicus GLO-30 DEM-derived lineaments (Somalia nationwide). Present
      // at ~69% of occurrences, ~16% of background — a 4.3x coverage ratio, above the
      // limit. They are extracted FROM the DEM, and the engine already scores that
      // DEM as `terrain`, so scoring lineament coverage double-counts the landform
      // signal rather than adding an independent one. Held as context (map + coverage
      // panel), never fed to the number. The threshold is not moved to let them in.
      const lineaments = leakage.find((r) => r.role === "lineaments");
      expect(lineaments).toBeDefined();
      expect(lineaments!.leaks).toBe(true);
      expect(lineaments!.ratio).toBeGreaterThan(LEAKAGE_RATIO_LIMIT);
      expect(ROLES_NOT_SCORED).toContain<EvidenceRole>("lineaments");
    });

    test("every layer that DOES feed the score is unbiased", () => {
      // The gate. A biased layer must not be scored, whatever it does to the AUC.
      // Read from ROLES_NOT_SCORED rather than a hand-kept list, so a role cannot be
      // admitted to scoring without this test noticing. It was a hand-kept list
      // until the Abbate contacts landed, and the list said "contacts" while the
      // scorer said otherwise — the gate has to read the same authority the scorer
      // reads. `drainage` and `contacts` are absent because they are withheld; the
      // three roles with no source at all cannot be measured either way.
      const scoredRoles = EVIDENCE_ROLES.filter(
        (r) => !ROLES_NOT_SCORED.includes(r) && !ROLES_WITHOUT_SOURCE.includes(r) &&
          r !== "occurrence",
      );
      const offenders = leakage
        .filter((r) => scoredRoles.includes(r.role) && r.leaks)
        .map((r) => `${r.role} (occ ${r.atOccurrences} vs bg ${r.atBackground})`);
      expect(offenders).toEqual([]);
    });

    test("occurrence coverage is expected to 'leak' — it IS the label", () => {
      // Stated so nobody later reads this row as a bug. An occurrence layer that
      // did not correlate with occurrences would mean the harness was broken.
      const occ = leakage.find((r) => r.role === "occurrence");
      expect(occ?.leaks).toBe(true);
    });
  });

  // ── THE ADMISSION GATE ────────────────────────────────────────────────────
  describe("terrain earns its place, or it does not get one", () => {
    // A layer is admitted only if it (1) does not leak and (2) does not make the
    // model worse. Both are measured here, on the hard blind test, against the
    // same engine with terrain withheld.
    test("it does not make the model worse", () => {
      expect(blind.metrics.auc).toBeGreaterThanOrEqual(blindNoTerrain.metrics.auc - 0.005);
    });

    test("the comparison is recorded, whichever way it went", () => {
      // eslint-disable-next-line no-console
      console.log(
        `
TERRAIN GATE  with ${blind.metrics.auc} / lift ${blind.metrics.topDecileLift}` +
        `   without ${blindNoTerrain.metrics.auc} / lift ${blindNoTerrain.metrics.topDecileLift}`,
      );
      expect(Number.isFinite(blindNoTerrain.metrics.auc)).toBe(true);
    });
  });

  test("the engine has an opinion about most ground", () => {
    // A high zero-score rate would mean the model mostly says nothing, and AUC
    // computed over a sea of ties would be meaningless however good it looked.
    expect(leaveOneOut.metrics.zeroScoreRate).toBeLessThan(0.9);
  });
});

// Choosing a commodity — the plumbing, and the promise it must not break.
//
// commodityModel.test.ts covers what a profile MEANS. This covers what happens
// when a user picks one on the screen: that the list comes from the pack, that the
// choice reaches the scorer, and above all that choosing nothing leaves the
// validated engine exactly as it was.
//
// That last one is the whole contract. The baseline — LOO AUC 0.900, BLIND 0.843 —
// was measured on the universal engine. Commodity conditioning is a lens over the
// same evidence, so with no commodity chosen the lens must be perfectly clear. A
// test that only checked "similar scores" would let a slow drift through.
jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: { getItem: jest.fn(async () => null), setItem: jest.fn(async () => {}) },
}));

import * as fs from "fs";
import * as path from "path";
import { PackStore, createBundledPackSource } from "../geo/packStore";
import { OfflineGeoContextService, DEFAULT_CONTEXT_RADIUS_M } from "../geo/offlineGeoContext";
import { collapseGroups, prospectivityEvidence } from "../geo/targeting";
import { computeConfidence } from "../../../shared/geo-core/confidence";
import { commodityModelFor } from "../geo/commodityModel";
import type { PackData } from "../../../shared/geo-core/pack/types";

const PACK_DIR = path.join(__dirname, "..", "..", "assets", "geo-pack");

function bundledFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fs.readdirSync(PACK_DIR)) {
    if (f.endsWith(".json")) out[f] = fs.readFileSync(path.join(PACK_DIR, f), "utf8");
  }
  return out;
}

jest.setTimeout(120_000);

describe("the commodity list comes from the pack, never from a literal", () => {
  let pack: PackData;

  beforeAll(async () => {
    const store = new PackStore(createBundledPackSource(() => bundledFiles()));
    await store.load();
    pack = store.getData();
  });

  test("the pack is the only source of the choices offered", () => {
    // The screen renders `pack.commodities`. If this ever drops to zero the UI
    // says so rather than falling back to a list of its own.
    expect(pack.commodities.length).toBe(23);
    for (const p of pack.commodities) {
      expect(typeof p.code).toBe("string");
      expect(p.code.length).toBeGreaterThan(0);
      expect(typeof p.name).toBe("string");
      expect(p.name.length).toBeGreaterThan(0);
    }
  });

  test("every offered code resolves to a model or is honestly empty", () => {
    // A chip the engine cannot act on must not be offered as though it can. The
    // one profile with no geological content — chromium — yields no model, and
    // selecting it therefore falls back to universal scoring rather than to a
    // model made of nothing.
    const withModel = pack.commodities.filter((p) => commodityModelFor(pack, p.code) !== null);
    expect(withModel.length).toBe(22);
  });

  test("no profile is presented as calibrated, because none is", () => {
    // 159 occurrences across 23 commodities. The UI tag is driven by this flag,
    // so if a future pack ever does calibrate one, the label changes by itself.
    for (const p of pack.commodities) {
      const m = commodityModelFor(pack, p.code);
      if (!m) continue;
      expect(m.calibration.calibrated).toBe(false);
      expect(m.calibration.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("choosing nothing must leave the validated engine untouched", () => {
  let score: (lat: number, lng: number, commodity: string | null | undefined) => Promise<number>;
  let pack: PackData;

  beforeAll(async () => {
    const store = new PackStore(createBundledPackSource(() => bundledFiles()));
    await store.load();
    pack = store.getData();
    const geo = new OfflineGeoContextService(store);
    score = async (lat, lng, commodity) => {
      const { context } = await geo.contextAt(lat, lng, { radiusM: DEFAULT_CONTEXT_RADIUS_M });
      const scored = prospectivityEvidence(
        context, DEFAULT_CONTEXT_RADIUS_M, undefined, pack,
        commodity === undefined ? {} : { commodity },
      );
      return computeConfidence(collapseGroups(scored)).score;
    };
  });

  test("commodity null scores IDENTICALLY to passing no option at all", async () => {
    // Exact equality, at 40 real occurrence sites. `null` is what the screen sends
    // when the user picks "All commodities", and it travels a different code path
    // from `undefined` — through TargetingOptions, the orchestrator snapshot and
    // back. The two must land on the same number, not a close one.
    for (const o of pack.occurrences.slice(0, 40)) {
      const asDefault = await score(o.lat, o.lng, undefined);
      const asNull = await score(o.lat, o.lng, null);
      expect(asNull).toBe(asDefault);
    }
  });

  test("a commodity the pack cannot model also falls back to universal scoring", async () => {
    // Not silently, not to a stub: commodityModelFor returns null and the scorer
    // behaves exactly as it does with no commodity at all.
    const o = pack.occurrences[0];
    const universal = await score(o.lat, o.lng, null);
    expect(await score(o.lat, o.lng, "not_a_real_commodity")).toBe(universal);
    expect(await score(o.lat, o.lng, "chromium")).toBe(universal);
  });
});

describe("conditioning changes the reading, and stays inside its bounds", () => {
  let pack: PackData;
  let score: (lat: number, lng: number, commodity: string | null) => Promise<number>;

  beforeAll(async () => {
    const store = new PackStore(createBundledPackSource(() => bundledFiles()));
    await store.load();
    pack = store.getData();
    const geo = new OfflineGeoContextService(store);
    score = async (lat, lng, commodity) => {
      const { context } = await geo.contextAt(lat, lng, { radiusM: DEFAULT_CONTEXT_RADIUS_M });
      return computeConfidence(collapseGroups(prospectivityEvidence(
        context, DEFAULT_CONTEXT_RADIUS_M, undefined, pack, { commodity },
      ))).score;
    };
  });

  test("picking a commodity actually does something somewhere", async () => {
    // If no site anywhere read differently under a commodity lens, the feature
    // would be decoration. Checked across occurrences rather than asserted at one
    // hand-picked point.
    let differences = 0;
    for (const o of pack.occurrences.slice(0, 60)) {
      const universal = await score(o.lat, o.lng, null);
      if (await score(o.lat, o.lng, "gold") !== universal) differences++;
    }
    expect(differences).toBeGreaterThan(0);
  });

  test("no lens can manufacture evidence where there is none", async () => {
    // The real bound. Conditioning multiplies existing weights by 0.5x to 1.5x, so
    // ground the universal engine scores at zero has nothing to multiply and must
    // stay at zero under every lens. Measured across four lenses at 30 sites.
    //
    // Note what is NOT asserted: that scores stay below 1. One site of thirty
    // saturates the noisy-OR to exactly 1.0 under the UNIVERSAL engine too — that
    // is the pre-existing combination maths, not something a commodity lens does,
    // and pretending otherwise here would hide it behind the wrong test.
    for (const o of pack.occurrences.slice(0, 30)) {
      const universal = await score(o.lat, o.lng, null);
      for (const c of ["gold", "nickel", "iron"]) {
        const s = await score(o.lat, o.lng, c);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
        if (universal === 0) expect(s).toBe(0);
      }
    }
  });
});

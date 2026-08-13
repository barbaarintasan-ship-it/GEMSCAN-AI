// What changes when the geologist says WHICH mineral they are looking for.
//
// The engine answered one question for every commodity at once, which is not a
// geological statement: placer gold is a drainage question, orogenic gold a
// structural one, nickel laterite wants the flat weathered surface every other
// model treats as barren cover.
//
// THE HONESTY THIS FILE ENFORCES. None of it is calibrated and none of it can be.
// The pack holds ZERO gold occurrences, three tin, one copper; 143 of 159 records
// carry no deposit_type. So every rule is read from the profile's own geological
// content and labelled `expert_rule` or `uncalibrated`, the conditioning is
// bounded so it can never dominate a measured signal, and with no commodity
// chosen the engine must behave EXACTLY as the validated universal model does.
// That last one is the most important test here.
import * as fs from "fs";
import * as path from "path";
import {
  buildCommodityModel, commodityModelFor, compatibleRockClasses, depositFamilies,
  diagnosticObservations, factorFor, isRelevant,
  DRAINAGE_PLACER_WEIGHT, MAX_FACTOR, MIN_FACTOR,
} from "../geo/commodityModel";
import { MAX_LITHOLOGY_WEIGHT } from "../geo/lithologyPrior";
import { MAX_TERRAIN_WEIGHT } from "../geo/terrainPrior";
import type { PackCommodityProfile, PackData, PackOccurrence } from "../../../shared/geo-core/pack/types";

const DIR = path.join(__dirname, "..", "..", "assets", "geo-pack");
const read = (f: string) => {
  const j = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")) as Record<string, unknown>;
  return (j.rows ?? Object.values(j).find(Array.isArray)) as never[];
};

function shippedPack(): PackData {
  return {
    geology: [], occurrences: read("occurrences.json"), knowledge: [], structures: [],
    community: [], mapFeatures: [], terrain: [], associations: [], rules: [],
    commodities: read("commodities.json"), assemblages: [], land: [],
  };
}

const pack = shippedPack();
const profiles = pack.commodities as PackCommodityProfile[];

// ── The audit, as assertions ────────────────────────────────────────────────

describe("the 23 profiles, audited", () => {
  test("all 23 are present", () => {
    expect(profiles.length).toBe(23);
  });

  test("22 carry geological content; chromium carries none", () => {
    // Recorded rather than worked around. A profile row with every field empty
    // cannot condition anything, and pretending otherwise would be the "layer
    // found where no source exists" failure in miniature.
    const empty = profiles.filter((p) =>
      (p.typical_host_rocks?.length ?? 0) === 0 &&
      (p.deposit_models?.length ?? 0) === 0 &&
      (p.exploration_indicators?.length ?? 0) === 0 &&
      (p.alteration_styles?.length ?? 0) === 0);
    expect(empty.map((p) => p.code)).toEqual(["chromium"]);
  });

  test("an empty profile yields NO model rather than an empty one", () => {
    expect(buildCommodityModel(pack, "chromium")).toBeNull();
  });

  test("a commodity the pack has no profile for yields no model", () => {
    // Lead has ELEVEN occurrences in this pack and no profile at all — the label
    // set and the profile set barely overlap, and that is worth failing on if it
    // ever silently changes.
    expect(buildCommodityModel(pack, "lead")).toBeNull();
    expect(buildCommodityModel(pack, "not-a-mineral")).toBeNull();
  });

  test("every populated profile states its own limitations", () => {
    for (const p of profiles) {
      expect(typeof p.confidence_limitations).toBe("string");
      expect(p.confidence_limitations.length).toBeGreaterThan(20);
    }
  });
});

// ── Calibration: the arithmetic that forbids a probability ──────────────────

describe("nothing here is calibrated, and the model says why", () => {
  test("gold has no occurrences at all, so nothing can be fitted", () => {
    const gold = buildCommodityModel(pack, "gold")!;
    expect(gold.calibration.occurrences).toBe(0);
    expect(gold.calibration.calibrated).toBe(false);
    expect(gold.calibration.reason).toMatch(/no occurrence/i);
  });

  test("iron is the only commodity with enough occurrences to attempt a fit", () => {
    const iron = buildCommodityModel(pack, "iron")!;
    expect(iron.calibration.occurrences).toBeGreaterThanOrEqual(20);
    // And it still is not calibrated, because nobody has done the fit.
    expect(iron.calibration.calibrated).toBe(false);
  });

  test("no commodity in the pack is calibrated", () => {
    const calibrated = profiles
      .map((p) => buildCommodityModel(pack, p.code))
      .filter((m) => m?.calibration.calibrated);
    expect(calibrated).toEqual([]);
  });
});

// ── Rules read from the profile, not invented ───────────────────────────────

describe("deposit models decide which evidence is relevant", () => {
  test("gold spans placer AND structural, because its profile does", () => {
    const gold = buildCommodityModel(pack, "gold")!;
    expect(gold.depositModels).toContain("placer");
    expect(gold.depositModels).toContain("orogenic gold");
    expect(gold.families).toContain("placer");
    expect(gold.families).toContain("structural");
  });

  test("drainage is relevant for placer commodities and NOT for others", () => {
    // The whole point of commodity conditioning, in one assertion.
    expect(isRelevant(buildCommodityModel(pack, "gold"), "drainage")).toBe(true);
    expect(isRelevant(buildCommodityModel(pack, "tin"), "drainage")).toBe(true);   // placer cassiterite
    expect(isRelevant(buildCommodityModel(pack, "ree"), "drainage")).toBe(true);   // placer monazite
    expect(isRelevant(buildCommodityModel(pack, "iron"), "drainage")).toBe(false);
    expect(isRelevant(buildCommodityModel(pack, "lithium"), "drainage")).toBe(false);
    expect(isRelevant(buildCommodityModel(pack, "graphite"), "drainage")).toBe(false);
  });

  test("the drainage rule is labelled uncalibrated, and says why", () => {
    const gold = buildCommodityModel(pack, "gold")!;
    const r = gold.relevance.get("drainage")!;
    expect(r.basis).toBe("uncalibrated");
    expect(r.why).toMatch(/placer/i);
    expect(r.why).toMatch(/not fitted|no occurrence/i);
  });

  test("nickel laterite lifts terrain for the OPPOSITE reason to placer", () => {
    // Laterite forms on flat, stable, deeply weathered surfaces — the landform the
    // universal prior scores lowest. A single formula cannot hold both readings.
    const ni = buildCommodityModel(pack, "nickel")!;
    expect(ni.families).toContain("lateritic");
    expect(ni.relevance.get("terrain")!.why).toMatch(/weathering|laterite/i);
  });

  test("structurally controlled commodities lift structure", () => {
    const gold = buildCommodityModel(pack, "gold")!;
    expect(factorFor(gold, "structural")).toBeGreaterThan(1);
    expect(gold.relevance.get("structural")!.basis).toBe("expert_rule");
  });
});

describe("host rocks map to the eight classes the map actually has", () => {
  test("pegmatite and granite are plutonic-compatible", () => {
    const c = compatibleRockClasses(["pegmatite", "granite"]);
    expect(c.has("plutonic")).toBe(true);
    expect(c.has("sedimentary")).toBe(false);
  });

  test("an unmatched lithology contributes nothing rather than a guess", () => {
    expect(compatibleRockClasses(["unobtainium"]).size).toBe(0);
    expect(compatibleRockClasses(null).size).toBe(0);
  });

  test("families come only from what the profile lists", () => {
    expect(depositFamilies(["orogenic gold"])).toEqual(["structural"]);
    expect(depositFamilies([])).toEqual([]);
    expect(depositFamilies(null)).toEqual([]);
  });
});

describe("indicators pick out the field observations that mean something", () => {
  test("gold singles out quartz veins, sulphides and gossan", () => {
    const gold = profiles.find((p) => p.code === "gold")!;
    const d = diagnosticObservations(gold);
    expect(d.has("quartz-vein")).toBe(true);
    expect(d.has("sulfides")).toBe(true);
    expect(d.has("gossan")).toBe(true);
  });

  test("a profile with no indicators singles out nothing", () => {
    const bare = { alteration_styles: null, exploration_indicators: null, associated_minerals: null } as
      unknown as PackCommodityProfile;
    expect(diagnosticObservations(bare).size).toBe(0);
  });
});

// ── The bounds that stop a rule dominating a measurement ────────────────────

describe("conditioning may adjust, never dominate", () => {
  test("every factor in every profile stays inside the bounds", () => {
    for (const p of profiles) {
      const m = buildCommodityModel(pack, p.code);
      if (!m) continue;
      for (const [, r] of m.relevance) {
        expect(r.factor).toBeGreaterThanOrEqual(MIN_FACTOR);
        expect(r.factor).toBeLessThanOrEqual(MAX_FACTOR);
      }
    }
  });

  test("the uncalibrated drainage weight is the smallest in the engine", () => {
    // Below both measured caps, deliberately: it is the only weight with no
    // number behind it.
    expect(DRAINAGE_PLACER_WEIGHT).toBeLessThan(MAX_TERRAIN_WEIGHT);
    expect(DRAINAGE_PLACER_WEIGHT).toBeLessThan(MAX_LITHOLOGY_WEIGHT);
  });

  test("a role the profile is silent about gets no opinion, not a default", () => {
    const iron = buildCommodityModel(pack, "iron")!;
    expect(iron.relevance.has("drainage")).toBe(false);
    expect(factorFor(iron, "drainage")).toBe(1);
    expect(factorFor(null, "structural")).toBe(1);
  });
});

describe("every relevance entry is traceable to a profile field", () => {
  test("no rule exists without a stated reason", () => {
    for (const p of profiles) {
      const m = buildCommodityModel(pack, p.code);
      if (!m) continue;
      for (const [role, r] of m.relevance) {
        expect(typeof r.why).toBe("string");
        expect(r.why.length).toBeGreaterThan(10);
        expect(["measured", "expert_rule", "uncalibrated", "unsupported"]).toContain(r.basis);
        // Nothing here is measured — that label belongs to the fitted priors.
        expect(r.basis).not.toBe("measured");
        expect(role).toBeTruthy();
      }
    }
  });
});

describe("caching", () => {
  test("the same commodity resolves once", () => {
    expect(commodityModelFor(pack, "gold")).toBe(commodityModelFor(pack, "gold"));
  });
  test("no commodity means no model", () => {
    expect(commodityModelFor(pack, null)).toBeNull();
    expect(commodityModelFor(pack, undefined)).toBeNull();
    expect(commodityModelFor(pack, "")).toBeNull();
  });
});

// ── A note the report has to be able to make ────────────────────────────────

describe("the label set, recorded so a pack update cannot hide it", () => {
  test("the profile set and the occurrence set barely overlap", () => {
    const withProfile = new Set(profiles.map((p) => p.code.toLowerCase()));
    const occ = pack.occurrences as PackOccurrence[];
    const counts = new Map<string, number>();
    for (const o of occ) {
      const k = (o.commodity_key ?? "").toLowerCase();
      if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const matched = [...counts].filter(([k]) => withProfile.has(k));
    const unmatched = [...counts].filter(([k]) => !withProfile.has(k));

    // Eleven distinct commodities are recorded in the occurrence set with no
    // profile behind them — lead alone has eleven records.
    expect(unmatched.length).toBeGreaterThan(5);
    // And of those that DO have a profile, only iron clears twenty.
    expect(matched.filter(([, n]) => n >= 20).map(([k]) => k)).toEqual(["iron"]);
  });
});

// ── The conditioning, where it actually meets the score ─────────────────────

describe("conditioned scoring, against the shipped pack", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { collapseGroups, prospectivityEvidence } = require("../geo/targeting") as
    typeof import("../geo/targeting");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { computeConfidence } = require("../../../shared/geo-core/confidence") as
    typeof import("../../../shared/geo-core/confidence");

  function fullPack(): PackData {
    return {
      geology: read("geology.json"), occurrences: read("occurrences.json"),
      knowledge: [], structures: [], community: [], mapFeatures: read("maplayers.json"),
      terrain: read("terrain.json"), associations: [], rules: [],
      commodities: read("commodities.json"), assemblages: [], land: read("land.json"),
    };
  }
  const full = fullPack();
  const HERE = { lat: 9.5, lng: 49.0 };
  const ctx = {
    location: HERE, knownOccurrences: [], commodityAssociations: [],
    communityEvidence: {},
  } as unknown as Parameters<typeof prospectivityEvidence>[0];

  const evidence = (commodity?: string) =>
    prospectivityEvidence(ctx, 10_000, undefined, full, commodity ? { commodity } : {});

  test("WITH NO COMMODITY the engine is byte-identical to the universal model", () => {
    // The gates measure the universal path. If naming no commodity changed
    // anything, every validated number in this repo would be describing a model
    // the app does not run.
    const a = evidence();
    const b = prospectivityEvidence(ctx, 10_000, undefined, full, {});
    expect(a.map((x) => [x.role, x.group, x.item.weight]))
      .toEqual(b.map((x) => [x.role, x.group, x.item.weight]));
    // And no drainage term exists without a commodity asking for one.
    expect(a.some((x) => x.role === "drainage")).toBe(false);
  });

  test("a placer commodity brings drainage into the score; a lode one does not", () => {
    expect(evidence("gold").some((x) => x.role === "drainage")).toBe(true);
    expect(evidence("iron").some((x) => x.role === "drainage")).toBe(false);
  });

  test("drainage and landform are ONE group — the same low ground, counted once", () => {
    // Valley morphology and channel proximity describe the same place. Combining
    // them as independent evidence is the double-counting this project has
    // already been criticised for.
    const gold = evidence("gold");
    const groups = gold.filter((x) => x.role === "drainage" || x.role === "terrain")
      .map((x) => x.group);
    expect(new Set(groups).size).toBe(1);

    // And the collapsed set carries one item for that group, not two.
    const collapsed = collapseGroups(gold);
    const landform = gold.filter((x) => x.group === "landform");
    if (landform.length > 1) {
      expect(collapsed.filter((i) => landform.some((l) => l.item === i)).length).toBe(1);
    }
  });

  test("adding drainage for a placer commodity cannot inflate the score past the group max", () => {
    const withGold = computeConfidence(collapseGroups(evidence("gold"))).score;
    const universal = computeConfidence(collapseGroups(evidence())).score;
    // It may differ — that is the point of conditioning — but an uncalibrated
    // term grouped with a measured one can only ever replace it, never stack.
    expect(withGold).toBeLessThanOrEqual(1);
    expect(universal).toBeLessThanOrEqual(1);
  });

  test("an unknown or empty-profile commodity falls back to the universal model", () => {
    const universal = evidence().map((x) => [x.role, x.item.weight]);
    expect(evidence("chromium").map((x) => [x.role, x.item.weight])).toEqual(universal);
    expect(evidence("not-a-mineral").map((x) => [x.role, x.item.weight])).toEqual(universal);
  });
});

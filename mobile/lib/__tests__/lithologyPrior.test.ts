// Which rock classes host mineralisation — fitted from the pack, not asserted.
//
// Geology contributed nothing to prospectivity for a defensible reason: scoring a
// cell for being well MAPPED rewards good survey coverage, not good ground. The
// correction was to score the rock CLASS instead, and the pack says that class
// carries real signal — 118 of 158 occurrences (75%) inside 11% of the mapped
// area, with a leakage ratio of 0.99.
//
// What is asserted below is mostly the HUMILITY. An enrichment ratio computed
// from a handful of points in a small polygon is nearly meaningless, and a model
// that treats it as diagnostic is worse than one that ignores geology entirely.
// So the interesting cases are the ones the prior refuses to get excited about.
import {
  buildLithologyPrior, lithologyPriorFor, MAX_LITHOLOGY_WEIGHT,
} from "../geo/lithologyPrior";
import type { PackData, PackGeologyUnit, PackOccurrence } from "../../../shared/geo-core/pack/types";

/** A square unit of roughly `deg` degrees a side, centred on (lng, lat). */
function unit(id: string, kind: string, lng: number, lat: number, deg: number): PackGeologyUnit {
  const h = deg / 2;
  return {
    id, name: `${kind} unit`, kind, source: "test", attributes: null,
    rings: [[
      [lng - h, lat - h], [lng + h, lat - h], [lng + h, lat + h], [lng - h, lat + h], [lng - h, lat - h],
    ]],
    bbox: [lng - h, lat - h, lng + h, lat + h],
    isPolygon: true,
  };
}

function occurrence(id: string, lng: number, lat: number): PackOccurrence {
  return {
    id, name: null, commodity_key: "gold", deposit_type: null, host_rocks: null,
    lat, lng, dataset_id: "d", source: "MRDS", version: null, reference: null, cell: "c",
  };
}

function pack(geology: PackGeologyUnit[], occurrences: PackOccurrence[]): PackData {
  return {
    geology, occurrences, knowledge: [], structures: [], community: [],
    mapFeatures: [], terrain: [], associations: [], rules: [], commodities: [],
    assemblages: [], land: [],
  };
}

/** Points scattered inside a unit, deterministically. */
function scatter(n: number, lng: number, lat: number, deg: number, tag: string): PackOccurrence[] {
  const out: PackOccurrence[] = [];
  const step = deg / (n + 1);
  for (let i = 1; i <= n; i++) {
    out.push(occurrence(`${tag}${i}`, lng - deg / 2 + i * step, lat));
  }
  return out;
}

describe("the prior is fitted from the pack, and says so", () => {
  test("a class holding most occurrences in little area is enriched", () => {
    // 20 occurrences in a 1-degree box, 0 in a 4-degree box beside it.
    const p = pack(
      [unit("a", "metamorphic", 45, 5, 1), unit("b", "sedimentary", 49, 5, 4)],
      scatter(20, 45, 5, 1, "m"),
    );
    const prior = buildLithologyPrior(p);
    const meta = prior.statFor("metamorphic")!;
    const sed = prior.statFor("sedimentary")!;

    expect(meta.observed).toBe(20);
    expect(meta.enrichment).toBeGreaterThan(2);
    expect(meta.weight).toBeGreaterThan(0);
    // A class with none, over a much larger area, is not prospective ground.
    expect(sed.observed).toBe(0);
    expect(sed.enrichment).toBeLessThan(1);
    expect(sed.weight).toBe(0);
  });

  test("average ground earns nothing — enrichment 1 is not evidence", () => {
    // Two classes of equal area sharing the occurrences evenly.
    const p = pack(
      [unit("a", "metamorphic", 45, 5, 2), unit("b", "sedimentary", 49, 5, 2)],
      [...scatter(10, 45, 5, 2, "m"), ...scatter(10, 49, 5, 2, "s")],
    );
    const prior = buildLithologyPrior(p);
    expect(prior.weightFor("metamorphic")).toBe(0);
    expect(prior.weightFor("sedimentary")).toBe(0);
  });
});

describe("what it refuses to get excited about", () => {
  test("zero occurrences in a SMALL area stays near neutral, not damned", () => {
    // The difference shrinkage exists for. A tiny polygon with no recorded finds
    // is a small sample, not a statement that the rock is barren.
    const p = pack(
      [unit("big", "metamorphic", 45, 5, 4), unit("tiny", "plutonic", 49, 5, 0.2)],
      scatter(30, 45, 5, 4, "m"),
    );
    const prior = buildLithologyPrior(p);
    const tiny = prior.statFor("plutonic")!;
    expect(tiny.observed).toBe(0);
    // Near 1: the prior has almost no opinion, which is the honest one.
    expect(tiny.enrichment).toBeGreaterThan(0.5);
    expect(tiny.weight).toBe(0);
  });

  test("zero occurrences over a HUGE area is a real statement, and shrinks less", () => {
    const p = pack(
      [unit("small", "metamorphic", 45, 5, 1), unit("huge", "volcanic", 49, 5, 8)],
      scatter(30, 45, 5, 1, "m"),
    );
    const prior = buildLithologyPrior(p);
    const huge = prior.statFor("volcanic")!;
    const enrichTiny = buildLithologyPrior(pack(
      [unit("small", "metamorphic", 45, 5, 1), unit("t", "volcanic", 49, 5, 0.2)],
      scatter(30, 45, 5, 1, "m"),
    )).statFor("volcanic")!.enrichment;
    // Same zero count; the larger the barren area, the stronger the statement.
    expect(huge.enrichment).toBeLessThan(enrichTiny);
  });

  test("a handful of points in a small polygon cannot reach the cap", () => {
    // Raw enrichment here is enormous; shrinkage must hold it down. Without it a
    // three-point cluster would outrank a class carrying a hundred occurrences.
    const p = pack(
      [unit("spot", "sedimentary and volcaniclastic", 45, 5, 0.05), unit("rest", "sedimentary", 49, 5, 6)],
      scatter(3, 45, 5, 0.05, "v"),
    );
    const prior = buildLithologyPrior(p);
    expect(prior.weightFor("sedimentary and volcaniclastic")).toBeLessThan(MAX_LITHOLOGY_WEIGHT);
  });

  test("an unknown class contributes nothing rather than a default", () => {
    const prior = buildLithologyPrior(pack([unit("a", "metamorphic", 45, 5, 1)], []));
    expect(prior.weightFor("kimberlite")).toBe(0);
    expect(prior.weightFor(null)).toBe(0);
    expect(prior.weightFor(undefined)).toBe(0);
  });

  test("an empty pack yields an empty prior instead of throwing", () => {
    const prior = buildLithologyPrior(pack([], []));
    expect(prior.stats).toEqual([]);
    expect(prior.weightFor("metamorphic")).toBe(0);
  });
});

describe("the cap", () => {
  test("no rock class can ever outweigh an observation", () => {
    // Permissive lithology is the weakest true thing the app can say. Sulfides in
    // hand are 0.85; an occurrence up to 0.9. This must stay well under both.
    const p = pack(
      [unit("a", "metamorphic", 45, 5, 0.5), unit("b", "sedimentary", 49, 5, 20)],
      scatter(60, 45, 5, 0.5, "m"),
    );
    const prior = buildLithologyPrior(p);
    expect(prior.weightFor("metamorphic")).toBeLessThanOrEqual(MAX_LITHOLOGY_WEIGHT);
    expect(MAX_LITHOLOGY_WEIGHT).toBeLessThan(0.35);
  });
});

describe("leave-one-out, for validation", () => {
  test("removing the occurrence under test lowers its own class's weight", () => {
    const p = pack(
      [unit("a", "metamorphic", 45, 5, 1), unit("b", "sedimentary", 49, 5, 6)],
      scatter(12, 45, 5, 1, "m"),
    );
    const prior = buildLithologyPrior(p);
    const full = prior.weightFor("metamorphic", false);
    const loo = prior.weightFor("metamorphic", true);
    expect(loo).toBeLessThan(full);
    // Small, as it should be with twelve points — but not zero, and not ignored.
    expect(full - loo).toBeLessThan(0.05);
  });

  test("it cannot drive a count below zero", () => {
    const p = pack([unit("a", "metamorphic", 45, 5, 1)], []);
    expect(prior_weight(p)).toBe(0);
    function prior_weight(pk: PackData) {
      return buildLithologyPrior(pk).weightFor("metamorphic", true);
    }
  });
});

describe("caching", () => {
  test("the same pack is fitted once", () => {
    const p = pack([unit("a", "metamorphic", 45, 5, 1)], scatter(5, 45, 5, 1, "m"));
    expect(lithologyPriorFor(p)).toBe(lithologyPriorFor(p));
  });

  test("a different pack gets its own prior", () => {
    const a = pack([unit("a", "metamorphic", 45, 5, 1)], scatter(5, 45, 5, 1, "m"));
    const b = pack([unit("a", "volcanic", 45, 5, 1)], scatter(5, 45, 5, 1, "m"));
    expect(lithologyPriorFor(a)).not.toBe(lithologyPriorFor(b));
  });
});

describe("the shipped pack, measured", () => {
  // A record of what the real data says, so that a pack update which changes the
  // geological picture cannot pass unnoticed.
  test("the numbers behind the decision to score geology", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs") as typeof import("fs");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require("path") as typeof import("path");
    const dir = path.join(__dirname, "..", "..", "assets", "geo-pack");
    const read = (f: string) => {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Record<string, unknown>;
      return (j.rows ?? Object.values(j).find(Array.isArray)) as unknown[];
    };
    const p = pack(read("geology.json") as PackGeologyUnit[], read("occurrences.json") as PackOccurrence[]);
    const prior = buildLithologyPrior(p);

    expect(prior.totalObserved).toBeGreaterThanOrEqual(150);
    // Metamorphic basement is the host, and it must earn a real weight.
    const meta = prior.statFor("metamorphic")!;
    expect(meta.observed).toBeGreaterThan(90);
    expect(meta.weight).toBeGreaterThan(0.2);
    // Cenozoic cover is not, and must earn nothing.
    expect(prior.weightFor("volcanic")).toBe(0);
    expect(prior.weightFor("sedimentary")).toBe(0);
  });
});

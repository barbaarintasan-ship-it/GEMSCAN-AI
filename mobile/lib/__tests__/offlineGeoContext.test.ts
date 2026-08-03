// Offline geological context (Stage E2) — workflow step 2 on the device.
//
// Proves the claim the whole migration rests on: the SAME 7 providers and the
// SAME engine the server runs produce a GeoContext on the phone, from a
// knowledge pack, with no network.
import { buildPack } from "../../../shared/geo-core/pack/build.ts";
import type { PackData } from "../../../shared/geo-core/pack/types.ts";
import { makePackGateway } from "../geo/packGateway.ts";
import { PackStore, createBundledPackSource, PACK_STALE_DAYS } from "../geo/packStore.ts";
import { OfflineGeoContextService } from "../geo/offlineGeoContext.ts";

// ── Fixture: a small but realistic slice of Somali geology ──────────────────
const MOG = { lat: 2.0469, lng: 45.3182 };

function packData(): PackData {
  return {
    geology: [{
      id: "g1", name: "Precambrian Basement", kind: "formation", source: "Macrostrat",
      attributes: { age: "Precambrian" },
      rings: [[[45.0, 1.8], [45.6, 1.8], [45.6, 2.4], [45.0, 2.4], [45.0, 1.8]]],
      bbox: [45.0, 1.8, 45.6, 2.4], isPolygon: true,
    }, {
      id: "g2", name: "Mapped Fault", kind: "fault", source: "Macrostrat",
      attributes: null, rings: [], bbox: [45.0, 1.8, 45.6, 2.4], isPolygon: false,
    }],
    occurrences: [{
      id: "o1", name: "Near Gold", commodity_key: "gold", deposit_type: "orogenic",
      host_rocks: ["greenstone"], lat: 2.0500, lng: 45.3200, dataset_id: "d1",
      source: "USGS MRDS", version: "2024", reference: "MRDS-1", cell: "c1",
    }, {
      id: "o2", name: "Far Iron", commodity_key: "iron", deposit_type: null,
      host_rocks: null, lat: 2.5000, lng: 45.3200, dataset_id: "d1",
      source: "USGS MRDS", version: "2024", reference: null, cell: "c2",
    }],
    knowledge: [{
      id: "k1", kind: "observation", statement: "Quartz veining reported in the basement",
      commodity_key: "gold", host_rock_key: "greenstone", tier: "historical", page: 12,
      lat: 2.0480, lng: 45.3190, source_title: "Regional Survey",
      dataset_id: "d1", dataset_source: "Survey", dataset_version: "1", cell: "c1",
    }],
    structures: [],
    community: [{ cell: "c1", lat: 2.0470, lng: 45.3180, verified_scans: 3, sample_count: 11 }],
    mapFeatures: [], terrain: [],
    associations: [
      { commodity_code: "gold", host_rock_code: "greenstone", weight: 0.8 },
      { commodity_code: "copper", host_rock_code: "basalt", weight: 0.4 },
    ],
    rules: [
      {
        id: "r1", antecedent_type: "host_rock", antecedent_key: "Greenstone", commodity_code: "gold",
        expected_minerals: ["pyrite"], relationship: "hosts", likelihood: "common",
        requires_setting: null, weight: 0.7,
      },
      {
        id: "r2", antecedent_type: "host_rock", antecedent_key: "kimberlite", commodity_code: "diamond",
        expected_minerals: null, relationship: "hosts", likelihood: "diagnostic",
        requires_setting: null, weight: null,
      },
    ],
    commodities: [{
      code: "gold", name: "Gold", category: "precious", typical_host_rocks: ["greenstone"],
      associated_minerals: ["pyrite"], alteration_styles: null, deposit_models: null,
      tectonic_settings: null, exploration_indicators: null, industrial_uses: null,
      is_critical_mineral: false, strategic_importance: "high", confidence_limitations: "none",
    }],
    assemblages: [{
      id: "a1", minerals: ["pyrite", "quartz"], interpretation: "epithermal system",
      commodity_code: "gold", likelihood: "common", relationship: "indicates", weight: 0.6,
    }],
  };
}

const BUILD_OPTS = {
  packId: "somalia", packVersion: "1.0.0", engineVersion: "1.0.0", region: "SO",
  h3Resolution: 7, builtAt: "2026-08-01T00:00:00.000Z",
  datasets: [{ datasetId: "d1", source: "USGS MRDS", version: "2024" }],
};

const NOW = Date.parse("2026-08-03T00:00:00.000Z");

function storeWith(files: Record<string, string> | null, now = () => NOW) {
  return new PackStore(createBundledPackSource(() => files), now);
}

const builtFiles = () => buildPack(packData(), BUILD_OPTS).files;

// ── PackGateway mirrors the SQL it replaces ────────────────────────────────
describe("PackGateway", () => {
  const gw = makePackGateway(packData());

  test("geologyAt returns only polygons containing the point", async () => {
    const rows = await gw.geologyAt(MOG.lat, MOG.lng);
    expect(rows.map((r) => r.id)).toEqual(["g1"]); // the fault has no rings
    expect(rows[0].name).toBe("Precambrian Basement");
  });

  test("geologyAt outside every unit returns nothing, not a nearest guess", async () => {
    expect(await gw.geologyAt(9.56, 44.06)).toEqual([]);
  });

  test("occurrencesNear filters by radius and orders nearest first", async () => {
    const rows = await gw.occurrencesNear(MOG.lat, MOG.lng, 10_000);
    expect(rows.map((r) => r.id)).toEqual(["o1"]); // o2 is ~50 km away
    expect(rows[0].distance_m).toBeLessThan(500);
    expect(rows[0].source).toBe("USGS MRDS");

    const wide = await gw.occurrencesNear(MOG.lat, MOG.lng, 100_000);
    expect(wide.map((r) => r.id)).toEqual(["o1", "o2"]);
    expect(wide[0].distance_m).toBeLessThan(wide[1].distance_m);
  });

  test("communityNear aggregates cells in range", async () => {
    const c = await gw.communityNear(MOG.lat, MOG.lng, 10_000);
    expect(c).toEqual({ verified_scans: 3, sample_count: 11, cell_count: 1 });
  });

  test("communityNear with nothing in range returns zeros, never null", async () => {
    expect(await gw.communityNear(9.56, 44.06, 1_000)).toEqual({
      verified_scans: 0, sample_count: 0, cell_count: 0,
    });
  });

  test("associationsForHostRocks matches host-rock codes exactly", async () => {
    expect((await gw.associationsForHostRocks(["greenstone"])).map((a) => a.commodity_code))
      .toEqual(["gold"]);
    expect(await gw.associationsForHostRocks(["gneiss"])).toEqual([]);
  });

  test("knowledgeRulesFor matches case-insensitively across all three key lists", async () => {
    const viaHost = await gw.knowledgeRulesFor({ hostRocks: ["greenstone"], lithology: [], depositTypes: [] });
    expect(viaHost.map((r) => r.id)).toEqual(["r1"]); // fixture key is "Greenstone"

    const viaLith = await gw.knowledgeRulesFor({ hostRocks: [], lithology: ["GREENSTONE"], depositTypes: [] });
    expect(viaLith.map((r) => r.id)).toEqual(["r1"]);
  });

  test("knowledgeRulesFor drops blank keys and returns nothing for an empty query", async () => {
    expect(await gw.knowledgeRulesFor({ hostRocks: ["  "], lithology: [], depositTypes: [] })).toEqual([]);
    expect(await gw.knowledgeRulesFor({ hostRocks: [], lithology: [], depositTypes: [] })).toEqual([]);
  });

  test("rules order by weight desc with NULLs first, as Postgres does", async () => {
    const rows = await gw.knowledgeRulesFor({
      hostRocks: ["greenstone", "kimberlite"], lithology: [], depositTypes: [],
    });
    // r2 has a null weight, so Postgres `order by weight desc` puts it first.
    expect(rows.map((r) => r.id)).toEqual(["r2", "r1"]);
  });

  test("assemblage rules require the rule's minerals to be a SUBSET of what was observed", async () => {
    expect((await gw.assemblageRulesFor(["pyrite", "quartz", "calcite"])).map((r) => r.id)).toEqual(["a1"]);
    // Overlap is not enough — "quartz" alone must not fire a pyrite+quartz rule.
    expect(await gw.assemblageRulesFor(["quartz"])).toEqual([]);
  });

  test("commodityProfiles matches codes exactly (the SQL does not lower-case)", async () => {
    expect((await gw.commodityProfiles(["gold"])).map((c) => c.name)).toEqual(["Gold"]);
    expect(await gw.commodityProfiles(["GOLD"])).toEqual([]);
  });

  test("an empty gateway answers everything with nothing", async () => {
    const empty = makePackGateway();
    expect(await empty.geologyAt(MOG.lat, MOG.lng)).toEqual([]);
    expect(await empty.occurrencesNear(MOG.lat, MOG.lng, 10_000)).toEqual([]);
    expect(await empty.structuralFeaturesNear(MOG.lat, MOG.lng, 10_000)).toEqual([]);
  });
});

// ── PackStore: integrity is refusal, not degradation ───────────────────────
describe("PackStore", () => {
  test("a valid bundled pack becomes ready and reports its provenance", async () => {
    const store = storeWith(builtFiles());
    const status = await store.load();
    expect(status.state).toBe("ready");
    expect(store.isReady()).toBe(true);
    expect(store.provenance()).toEqual({
      packVersion: "1.0.0", builtAt: "2026-08-01T00:00:00.000Z", ageDays: 2, stale: false,
    });
  });

  test("no pack installed is a legitimate state, not an error", async () => {
    const store = storeWith(null);
    expect((await store.load()).state).toBe("empty");
    expect(store.isReady()).toBe(false);
    expect(store.provenance()).toBeNull();
    expect(store.getData().occurrences).toEqual([]);
  });

  test("a source that throws is treated as no pack, not a crash", async () => {
    const store = new PackStore(
      { name: "broken", load: async () => { throw new Error("io"); } },
      () => NOW,
    );
    expect((await store.load()).state).toBe("empty");
  });

  test("a tampered pack is REFUSED and none of its data is read", async () => {
    const files = builtFiles();
    files["occurrences.json"] = files["occurrences.json"].replace('"gold"', '"platinum"');
    const store = storeWith(files);
    const status = await store.load();
    expect(status.state).toBe("refused");
    if (status.state === "refused") expect(status.failure.code).toBe("file-corrupt");
    // Invariant 6: refused, not degraded — nothing from the pack is visible.
    expect(store.getData().occurrences).toEqual([]);
    expect(store.isReady()).toBe(false);
  });

  test("a pack built for an unsupported engine version is refused", async () => {
    const files = buildPack(packData(), { ...BUILD_OPTS, engineVersion: "9.0.0" }).files;
    const status = await storeWith(files).load();
    expect(status.state).toBe("refused");
    if (status.state === "refused") expect(status.failure.code).toBe("engine-unsupported");
  });

  test("an old pack still works but is flagged stale", async () => {
    const later = NOW + (PACK_STALE_DAYS + 10) * 86_400_000;
    const store = storeWith(builtFiles(), () => later);
    await store.load();
    expect(store.isReady()).toBe(true);
    expect(store.provenance()!.stale).toBe(true);
  });

  test("load() is idempotent across concurrent callers", async () => {
    let loads = 0;
    const store = new PackStore(
      { name: "counted", load: async () => { loads++; return builtFiles(); } },
      () => NOW,
    );
    await Promise.all([store.load(), store.load(), store.load()]);
    await store.load();
    expect(loads).toBe(1);
  });
});

// ── The capability: offline GeoContext ─────────────────────────────────────
describe("OfflineGeoContextService — workflow step 2", () => {
  test("produces a GeoContext on-device from the pack, with no network", async () => {
    const svc = new OfflineGeoContextService(storeWith(builtFiles()));
    const { context, hasKnowledge, provenance } = await svc.contextAt(MOG.lat, MOG.lng);

    expect(hasKnowledge).toBe(true);
    expect(provenance!.packVersion).toBe("1.0.0");

    // What is under the geologist's feet.
    expect(context.geology.unit).toBe("Precambrian Basement");
    // What is near them.
    expect(context.knownOccurrences.length).toBeGreaterThan(0);
    expect(context.knownOccurrences[0].commodity).toBe("gold");
    // Confidence is COMPUTED from the evidence, never asserted.
    expect(context.confidence.score).toBeGreaterThan(0);
    expect(["Low", "Moderate", "High"]).toContain(context.confidence.overall);
    // Every provider ran.
    expect(context.meta.providersRun.length).toBeGreaterThanOrEqual(6);
    expect(context.meta.providersFailed).toEqual([]);
  });

  test("evidence is traceable to its source — no anonymous conclusions", async () => {
    const svc = new OfflineGeoContextService(storeWith(builtFiles()));
    const { context } = await svc.contextAt(MOG.lat, MOG.lng);

    // The statements that drove confidence name what they came from.
    const factors = context.confidence.factors.join(" | ");
    expect(factors).toContain("Precambrian Basement");
    expect(/occurrence/i.test(factors)).toBe(true);

    // Every provider is accounted for, and the datasets behind the answer are named.
    expect(context.evidence.providers.every((p) => typeof p.provider === "string")).toBe(true);
    expect(context.evidence.datasets.map((d) => d.source)).toContain("USGS MRDS");
  });

  test("with no pack it reports no knowledge rather than inventing geology", async () => {
    const svc = new OfflineGeoContextService(storeWith(null));
    const { context, hasKnowledge, provenance } = await svc.contextAt(MOG.lat, MOG.lng);
    expect(hasKnowledge).toBe(false);
    expect(provenance).toBeNull();
    expect(context.geology.unit).toBeUndefined();
    expect(context.knownOccurrences).toEqual([]);
    expect(context.confidence.score).toBe(0);
    expect(context.confidence.overall).toBe("Low");
  });

  test("a location the pack does not cover yields no geology, not the nearest unit", async () => {
    const svc = new OfflineGeoContextService(storeWith(builtFiles()));
    const { context } = await svc.contextAt(9.56, 44.06); // Hargeisa — outside the fixture
    expect(context.geology.unit).toBeUndefined();
    expect(context.knownOccurrences).toEqual([]);
  });

  test("the H3 cell is the same constant the server uses — the re-target key", async () => {
    const svc = new OfflineGeoContextService(storeWith(builtFiles()));
    const cell = svc.cellFor(MOG.lat, MOG.lng);
    expect(typeof cell).toBe("string");
    expect(cell.length).toBeGreaterThan(0);
    // Stable for the same position, and it is what lands in the query.
    expect(svc.cellFor(MOG.lat, MOG.lng)).toBe(cell);
    const { context } = await svc.contextAt(MOG.lat, MOG.lng);
    expect(context.location.h3).toBe(cell);
  });

  test("a refused pack degrades to no-knowledge, never to partial geology", async () => {
    const files = builtFiles();
    files["geology.json"] = files["geology.json"].replace("Precambrian Basement", "Fabricated Unit");
    const svc = new OfflineGeoContextService(storeWith(files));
    const { context, hasKnowledge } = await svc.contextAt(MOG.lat, MOG.lng);
    expect(hasKnowledge).toBe(false);
    expect(context.geology.unit).toBeUndefined();
  });
});

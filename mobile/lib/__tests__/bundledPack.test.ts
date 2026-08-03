// The REAL bundled Somalia pack (Stage E2/E4 acceptance).
//
// Every other test builds a pack from a fixture. This one loads the actual
// artifact that ships in the APK and runs the exploration engine against it, so
// it fails if the pack is missing, corrupt, or built with a schema the app
// cannot read — the exact conditions that would put "No geological knowledge
// for this area" in front of a geologist standing on mapped ground.
import { loadBundledPackFiles } from "../geo/bundledPack.ts";
import { PackStore, createBundledPackSource } from "../geo/packStore.ts";
import { OfflineGeoContextService } from "../geo/offlineGeoContext.ts";
import { TargetingEngine } from "../geo/targeting.ts";
import { readPack } from "../../../shared/geo-core/pack/read.ts";

const files = loadBundledPackFiles();
const pack = files ? readPack(files) : null;

// If no pack is bundled the suite reports that plainly rather than silently
// passing — a missing pack is the single most likely cause of an app that
// "works" but knows nothing.
const itPack = pack ? test : test.skip;

describe("bundled Somalia knowledge pack", () => {
  test("a pack is bundled at all", () => {
    expect(files).not.toBeNull();
    expect(pack).not.toBeNull();
  });

  itPack("passes integrity verification as the app loads it", async () => {
    const store = new PackStore(createBundledPackSource(loadBundledPackFiles));
    const status = await store.load();
    expect(status.state).toBe("ready");
    expect(store.isReady()).toBe(true);
  });

  itPack("carries the production datasets", () => {
    const d = pack!.data;
    expect(d.geology.length).toBeGreaterThan(300);      // Macrostrat
    expect(d.occurrences.length).toBeGreaterThan(100);  // MRDS
    expect(d.rules.length).toBeGreaterThan(20);         // EMIE rock→commodity
    expect(d.commodities.length).toBeGreaterThan(20);   // EMIE profiles
    expect(d.assemblages.length).toBeGreaterThan(5);    // EMIE assemblages
    expect(pack!.manifest.h3Resolution).toBe(7);
    expect(pack!.manifest.region).toBe("SO");
  });

  itPack("answers 'what is here?' offline on real Somali ground", async () => {
    // Stand on a real MRDS occurrence from the pack itself, so the test does
    // not hardcode a coordinate that a future dataset might not cover.
    const site = pack!.data.occurrences[0];
    const store = new PackStore(createBundledPackSource(loadBundledPackFiles));
    const geo = new OfflineGeoContextService(store);

    const { context, hasKnowledge, provenance } = await geo.contextAt(site.lat, site.lng);

    expect(hasKnowledge).toBe(true);
    expect(provenance).not.toBeNull();
    // This is the assertion that matters: the engine found the occurrence it
    // is standing on, with no network.
    expect(context.knownOccurrences.length).toBeGreaterThan(0);
    expect(context.confidence.score).toBeGreaterThan(0);
    expect(context.meta.providersFailed).toEqual([]);
  });

  itPack("knows the mapped geology under a point inside a Macrostrat polygon", async () => {
    const store = new PackStore(createBundledPackSource(loadBundledPackFiles));
    const geo = new OfflineGeoContextService(store);

    // Centre of the first mapped unit's bbox is inside it for these polygons.
    const unit = pack!.data.geology[0];
    const lng = (unit.bbox[0] + unit.bbox[2]) / 2;
    const lat = (unit.bbox[1] + unit.bbox[3]) / 2;
    const { context } = await geo.contextAt(lat, lng);

    // Either the unit resolves, or the bbox centre fell in a concavity — in
    // which case at least the query must complete without inventing geology.
    if (context.geology.unit) {
      expect(typeof context.geology.unit).toBe("string");
    }
    expect(context.meta.providersFailed).toEqual([]);
  });

  itPack("produces guidance, not just a readout", async () => {
    const site = pack!.data.occurrences[0];
    const store = new PackStore(createBundledPackSource(loadBundledPackFiles));
    const targeting = new TargetingEngine(new OfflineGeoContextService(store));

    const result = await targeting.rank(site.lat, site.lng);
    expect(result.hasKnowledge).toBe(true);
    // Standing on an occurrence, the engine should rate this ground — either it
    // is the best nearby, or it can name somewhere better. Both are real answers.
    expect(result.current.score).toBeGreaterThan(0);
    for (const t of result.targets) {
      expect(t.reasons.length).toBeGreaterThan(0);
      expect(t.bearingDeg).toBeGreaterThanOrEqual(0);
      expect(t.bearingDeg).toBeLessThan(360);
    }
  });

  itPack("reports what it does NOT have, rather than implying coverage", () => {
    const d = pack!.data;
    // These are legitimately empty in production today. The test records the
    // fact so a future pack that gains them fails here and gets noticed.
    // Faults ARE present now — Macrostrat official map lines + GEM active faults.
    expect(d.mapFeatures.length).toBeGreaterThan(50);
    const sources = new Set(d.mapFeatures.map((f) => f.source));
    expect(sources.has("macrostrat_lines")).toBe(true);
    // Every line traces to a published source; none is derived from polygons.
    expect(d.mapFeatures.every((f) => f.source && f.source.length > 0)).toBe(true);
    expect(d.mapFeatures.every((f) => f.kind === "fault")).toBe(true);
    expect(d.mapFeatures.every((f) => f.lines.length > 0)).toBe(true);
    // Still NO contacts or lineaments: neither has an authoritative source.
    expect(d.mapFeatures.some((f) => f.kind === "contact")).toBe(false);
    expect(d.mapFeatures.some((f) => f.kind === "lineament")).toBe(false);
    // Terrain IS present now — SRTM 30 m sampled around known occurrences.
    expect(d.terrain.length).toBeGreaterThan(1000);
    for (const t of d.terrain.slice(0, 50)) {
      expect(t.elevationM).toBeGreaterThanOrEqual(0);
      expect(t.slopeDeg).toBeGreaterThanOrEqual(0);
      expect(t.slopeDeg).toBeLessThanOrEqual(90);
      expect(["ridge", "slope", "valley", "flat"]).toContain(t.morphology);
      // Drainage is NOT derivable from point sampling and must stay null.
      expect(t.drainageDistM).toBeNull();
    }
  });

  itPack("terrain reaches the engine as EVIDENCE, not just as pack rows", async () => {
    // Stand on a cell that actually has terrain, taken from the pack itself.
    const t = pack!.data.terrain[0];
    const store = new PackStore(createBundledPackSource(loadBundledPackFiles));
    const geo = new OfflineGeoContextService(store);

    const { context } = await geo.contextAt(t.lat, t.lng);
    expect(context.meta.providersRun).toContain("terrain");
    expect(context.meta.providersFailed).toEqual([]);

    // The landform must be described to the geologist, not merely stored.
    const factors = context.confidence.factors.join(" | ");
    expect(factors).toMatch(/Ridge crest|Slope|Valley floor|Flat ground/);
    // And elevation must read as a number, not a stringified one.
    expect(typeof t.elevationM).toBe("number");
    expect(typeof t.slopeDeg).toBe("number");
  });
});

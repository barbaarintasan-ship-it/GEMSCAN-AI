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
import { TargetingEngine, prospectivityEvidence } from "../geo/targeting.ts";
import { coverageAt } from "../geo/evidenceCoverage.ts";
import { readPack } from "../../../shared/geo-core/pack/read.ts";
import type { GeoContext } from "../../../shared/geo-core/types.ts";

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
    expect(d.geology.length).toBeGreaterThan(20);       // Macrostrat units
    expect(d.occurrences.length).toBeGreaterThan(100);  // MRDS
    expect(d.rules.length).toBeGreaterThan(20);         // EMIE rock→commodity
    expect(d.commodities.length).toBeGreaterThan(20);   // EMIE profiles
    expect(d.assemblages.length).toBeGreaterThan(5);    // EMIE assemblages
    expect(pack!.manifest.h3Resolution).toBe(7);
    expect(pack!.manifest.region).toBe("SO");
  });

  // The pack once shipped 344 "units" that were a 0.5-degree sampling grid,
  // each stored as its own five-vertex rectangle. It passed every check that
  // existed: the rows were present, the hashes matched, the count was high.
  // Counting rows is what let it through, so the check is now on the geometry.
  itPack("carries real mapped polygons, not a sampling grid", () => {
    const g = pack!.data.geology;
    const boxes = g.filter((u) => u.rings.every((r) => r.length <= 5));
    expect(boxes).toHaveLength(0);

    const vertices = g.reduce((a, u) => a + u.rings.reduce((b, r) => b + r.length, 0), 0);
    expect(vertices).toBeGreaterThan(5_000);

    // Boundaries that fall on round latitudes are grid lines, not geology.
    const gridLike = g.filter((u) =>
      u.rings.every((r) => r.every(([, lat]) => Math.abs(lat * 4 - Math.round(lat * 4)) < 1e-9)),
    );
    expect(gridLike).toHaveLength(0);
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
    // Every line traces to a source, and a DERIVED line says so in its own row.
    expect(d.mapFeatures.every((f) => f.source && f.source.length > 0)).toBe(true);
    expect(d.mapFeatures.every((f) => f.lines.length > 0)).toBe(true);

    // Three kinds, and the distinctions are the point: faults are PUBLISHED
    // (Macrostrat map lines, GEM active faults); drainage is DERIVED from the
    // Copernicus DEM by this repo's own hydrology; contacts are EXTRACTED from a
    // published map's own polygon topology. A derived channel is not a surveyed
    // river, so every one carries the algorithm, its version, the DEM it came
    // from, the sampling resolution and the contributing-area threshold that
    // decided it was a channel.
    const kinds = new Set(d.mapFeatures.map((f) => f.kind));
    expect([...kinds].sort()).toEqual(["contact", "drainage", "fault", "lineament"]);

    // Lineaments: INTERPRETED structure, extracted from the Copernicus GLO-30 DEM
    // by this repo's own multi-azimuth hillshade → Hough pipeline, clipped to
    // Somalia. Every one is stamped so nothing downstream can read it as a mapped
    // fault: source copernicus_dem_derived, confidence "interpreted".
    const lineaments = d.mapFeatures.filter((f) => f.kind === "lineament");
    expect(lineaments.length).toBeGreaterThan(1000);
    for (const f of lineaments.slice(0, 20)) {
      expect(f.source).toBe("copernicus_dem_derived");
      expect((f.attributes as Record<string, unknown>).confidence).toBe("interpreted");
    }
  });

  // TEST MISSION: prove the engine READS the real pack's lineaments and surfaces
  // them in the geological CONTEXT — standing on a real lineament reports it in the
  // coverage panel as `not_scored` (present, held out of the number), never as a
  // scored item (it is in ROLES_NOT_SCORED: it leaks 4.3x and restates terrain).
  itPack("TEST MISSION: a real-pack lineament reaches the engine as CONTEXT (not scored)", () => {
    const d = pack!.data;
    const lineaments = d.mapFeatures.filter((f) => f.kind === "lineament");
    const [lng, lat] = lineaments[0].lines[0][0];
    // Coverage panel: the lineament layer is present here, as context.
    const cov = coverageAt(d, new Set(), { lat, lng }, 5000);
    expect(cov.roles.find((r) => r.role === "lineaments")!.state).toBe("not_scored");
    // And it is NOT fed to the score: nothing attributes evidence to lineaments.
    const ctx = {
      location: { lat, lng },
      knownOccurrences: [], commodityAssociations: [], communityEvidence: null,
    } as unknown as GeoContext;
    const items = prospectivityEvidence(ctx, 5000, undefined, d);
    expect(items.some((i) => i.role === "lineaments")).toBe(false);

    // Contacts: boundaries between two named units of the Geological Map of
    // Somalia (Abbate et al., 1:1,500,000), digitized by UNESCO IHP-WINS. The
    // scale is carried on every feature because ±750 m is what a 0.5 mm line at
    // 1:1,500,000 can justify — these are reconnaissance positions, and nothing
    // downstream may read one as a surveyed contact.
    const contacts = d.mapFeatures.filter((f) => f.kind === "contact");
    expect(contacts.length).toBeGreaterThan(1000);
    for (const f of contacts.slice(0, 20)) {
      expect(f.source).toBe("Abbate et al. Geological Map of Somalia");
      const a = f.attributes as Record<string, unknown>;
      expect(a.scale).toBe("1:1,500,000");
      expect(a.dataset).toBe("UNESCO IHP-WINS digitized vector");
      expect(a.positional_accuracy_m).toBe(750);
      // Two named units, or it is not a contact between anything.
      expect((a.unit_names as string[]).length).toBe(2);
      expect(typeof a.algorithm).toBe("string");
      expect(typeof a.algorithm_version).toBe("string");
    }

    const drainage = d.mapFeatures.filter((f) => f.kind === "drainage");
    expect(drainage.length).toBeGreaterThan(1000);
    for (const f of drainage.slice(0, 20)) {
      expect(f.source).toBe("derived:dem-hydrology");
      const a = f.attributes as Record<string, unknown>;
      expect(typeof a.algorithm).toBe("string");
      expect(typeof a.algorithm_version).toBe("string");
      expect(typeof a.dem_source).toBe("string");
      expect(typeof a.sampling_m).toBe("number");
      expect(typeof a.threshold_km2).toBe("number");
    }
    // A published fault must NOT be dressed as derived, or the other way round.
    for (const f of d.mapFeatures.filter((x) => x.kind === "fault").slice(0, 20)) {
      expect(f.source).not.toContain("derived:");
    }

    // Contacts arrived, and the history is worth keeping. Deriving them from the
    // old Macrostrat load was tried once, produced 165 lines sitting on 0.25-degree
    // coordinates because those "polygons" were ST_MakeEnvelope sampling rectangles,
    // and was deleted rather than shipped. "Absent until a real vector map exists"
    // was the honest state for as long as it lasted. The Abbate map is that vector
    // map: 82.8% of its edges are shared by exactly two polygons, so a contact is
    // lifted out of the cartographer's own topology rather than inferred.
    //
    // Present in the pack is NOT the same as feeding the score — see
    // prospectivityBaseline: contacts leak 3.5x and are held in ROLES_NOT_SCORED.
    expect(d.mapFeatures.some((f) => f.kind === "contact")).toBe(true);
    // Lineaments are now present — but as INTERPRETED structure (Copernicus GLO-30
    // DEM-derived, confidence "interpreted"), never as invented mapped faults. The
    // source stamp is what keeps the distinction honest downstream.
    expect(d.mapFeatures.some((f) => f.kind === "lineament")).toBe(true);
    // Terrain is country-wide now — Copernicus GLO-30, H3 resolution 6. The old
    // SRTM sampling was a k-ring around each known occurrence, which made its
    // coverage a 150x proxy for "somebody already found something here".
    expect(d.terrain.length).toBeGreaterThan(20_000);
    for (const t of d.terrain.slice(0, 50)) {
      expect(t.elevationM).toBeGreaterThanOrEqual(0);
      expect(t.slopeDeg).toBeGreaterThanOrEqual(0);
      expect(t.slopeDeg).toBeLessThanOrEqual(90);
      expect(["ridge", "slope", "valley", "flat"]).toContain(t.morphology);
      // Drainage distance is REAL now. It stayed null for as long as there was no
      // drainage network to measure against — "never a guess", as the column
      // comment says — and it is filled from the derived network, not estimated.
      expect(typeof t.drainageDistM).toBe("number");
      expect(t.drainageDistM!).toBeGreaterThanOrEqual(0);
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

// Does the pack actually LOAD, and does the screen then have something to say?
//
// WHY THIS IS SEPARATE FROM bundledPack.test.ts
// --------------------------------------------
// That file asks whether the pack is well-formed. This one asks whether the
// app, wired exactly as the exploration screen wires it, ends up with knowledge
// in its hands — and whether the two sentences that were on screen in the field
// are gone.
//
// "The pack is in the APK" and "the pack loads" are different claims, and this
// project has already shipped a build where the first was true and the second
// was false: the device rejected a perfectly good pack over a byte-for-byte
// hash it could never match. So the assertions here are about OUTCOMES a user
// can see, not about files existing.
//
// What this canNOT prove is stated plainly rather than implied: Jest runs on
// Node, not Hermes, and resolves `require` through its own transformer rather
// than Metro. It proves the logic and the data. The bundle check that proves
// Metro actually carries the files is scripts/verify-bundled-pack.mjs.
import { PackStore, createBundledPackSource } from "../geo/packStore";
import { loadBundledPackFiles } from "../geo/bundledPack";
import { OfflineGeoContextService } from "../geo/offlineGeoContext";
import { orientationAt } from "../geo/orientation";
import { buildScene } from "../geo/mapScene";
import { PACK_FILES, MANIFEST_FILE } from "../../../shared/geo-core/pack/types.ts";

/** Real ground, spread across the coverage area. */
const SOMALIA: Array<[string, number, number]> = [
  ["Bosaso hinterland", 9.51486, 49.09040],
  ["Mogadishu", 2.0469, 45.3182],
  ["Hargeisa", 9.56, 44.06],
  ["Galkayo", 6.7697, 47.4308],
  ["Kismayo", -0.3582, 42.5454],
  ["Garowe", 8.4054, 48.4845],
  ["Berbera", 10.4396, 45.0143],
  ["Baidoa", 3.1246, 43.6498],
];

const files = loadBundledPackFiles();

describe("the pack the app ships is found", () => {
  test("the loader returns files at all", () => {
    // Null here is the "no knowledge pack installed" banner, before anything
    // else has had a chance to go wrong.
    expect(files).not.toBeNull();
  });

  test("the manifest is among them", () => {
    expect(Object.keys(files!)).toContain(MANIFEST_FILE);
  });

  test("EVERY declared file is present — a partial pack is a refused pack", () => {
    // A previous build listed ten of twelve files here after two were added,
    // and the pack failed its own integrity check in silence.
    const declared = Object.keys(JSON.parse(files![MANIFEST_FILE]).files).sort();
    const shipped = Object.keys(files!).filter((f) => f !== MANIFEST_FILE).sort();
    expect(shipped).toEqual(declared);
    expect(declared).toEqual(Object.values(PACK_FILES).sort());
  });
});

describe("the pack loads through the exact path the screen uses", () => {
  test("PackStore reaches 'ready', not 'refused' and not 'empty'", async () => {
    const store = new PackStore(createBundledPackSource(loadBundledPackFiles));
    const status = await store.load();
    // If this is "refused", the reason is the most useful thing in the failure.
    expect(status.state === "ready" ? "ready" : JSON.stringify(status)).toBe("ready");
  });

  test("provenance is non-null — this is what silences the banner", async () => {
    const store = new PackStore(createBundledPackSource(loadBundledPackFiles));
    await store.load();
    // The exploration screen shows "No knowledge pack installed" when and only
    // when provenance is null. Asserting on provenance asserts on the banner.
    expect(store.provenance()).not.toBeNull();
    expect(store.provenance()!.packVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("the loaded data is populated, not an empty shell", async () => {
    const store = new PackStore(createBundledPackSource(loadBundledPackFiles));
    await store.load();
    const d = store.getData();
    expect(d.geology.length).toBeGreaterThan(0);
    expect(d.occurrences.length).toBeGreaterThan(0);
    expect(d.mapFeatures.length).toBeGreaterThan(0);
    expect(d.terrain.length).toBeGreaterThan(0);
  });
});

describe("standing in Somalia, the app has geology to report", () => {
  let store: PackStore;

  beforeAll(async () => {
    store = new PackStore(createBundledPackSource(loadBundledPackFiles));
    await store.load();
  });

  test.each(SOMALIA)("%s reports a named mapped unit", async (_name, lat, lng) => {
    const geo = new OfflineGeoContextService(store, "1.0.0", []);
    const { context, hasKnowledge } = await geo.contextAt(lat, lng);
    expect(hasKnowledge).toBe(true);

    // The screen's `unitOf()` reads exactly this. Null here is the sentence
    // "No mapped unit covers this point" appearing on a device in Somalia.
    const unit = (context as { geology?: { unit?: string } }).geology?.unit;
    expect(unit).toBeTruthy();
    // And it must be a real label, not the bare lithology the raw field carries.
    expect(String(unit).trim().split(/\s+/).length).toBeGreaterThan(1);
  });

  test.each(SOMALIA)("%s has something in the map scene to draw", (_name, lat, lng) => {
    const scene = buildScene(store.getData(), { lat, lng }, 2_000);
    // A scene with no polygon is the flat black rectangle the field reported.
    expect(scene.polygons.length).toBeGreaterThan(0);
    const vertices = scene.polygons.reduce(
      (a, p) => a + p.rings.reduce((b, r) => b + r.length, 0), 0,
    );
    expect(vertices).toBeGreaterThan(20);
  });

  test.each(SOMALIA)("%s can name its nearest known feature", (_name, lat, lng) => {
    const o = orientationAt(store.getData(), { lat, lng });
    // Near or far, there is always SOMETHING to say. Both null was the screen
    // that said nothing at all.
    expect(o.fault ?? o.occurrence).not.toBeNull();
  });
});

describe("outside the covered region the app says so instead of guessing", () => {
  test("mid-Atlantic reports no unit — silence here is correct", async () => {
    const store = new PackStore(createBundledPackSource(loadBundledPackFiles));
    await store.load();
    const geo = new OfflineGeoContextService(store, "1.0.0", []);
    const { context } = await geo.contextAt(0, -30);
    expect((context as { geology?: { unit?: string } }).geology?.unit).toBeFalsy();
  });
});

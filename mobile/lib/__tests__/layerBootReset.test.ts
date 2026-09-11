// A stored "satellite/hillshade/roads/labels: true" from a prior session made
// the map retry its Esri tile fetch on every subsequent cold boot — a real,
// reported stall opening or closing the app. These four are the ONLY layers
// backed by a live network fetch rather than the offline pack; the other
// seventeen (geology, faults, contacts, lineaments, occurrences, terrain,
// slope, aspect, drainage, land, geologyLabels, waypoints, track, target,
// accuracy, compass, grid) are pure offline-pack draws and must keep
// persisting normally — this is not a blanket "stop remembering layers" fix.
//
// Source-pattern assertion, matching this file's siblings
// (mapFirstArchitecture.test.ts): there is no React harness for
// MapWorkspaceProvider's effects, and the invariant is exactly which four
// identifiers appear in the post-load override, so the prose and the code
// name the same thing.
import * as fs from "fs";
import * as path from "path";

const WORKSPACE = path.join(__dirname, "..", "exploration", "workspace.tsx");
const src = fs.readFileSync(WORKSPACE, "utf8");

describe("the four network-tile layers never start pre-armed on a cold boot", () => {
  test("loadLayers' result is overridden with all four forced off", () => {
    const match = src.match(/void loadLayers\(DEFAULT_LAYERS\)\.then\(\(stored\) => \{\s*setLayers\(([^)]+)\)/);
    expect(match).not.toBeNull();
    const arg = match![1];
    expect(arg).toContain("...stored");
    expect(arg).toContain("satellite: false");
    expect(arg).toContain("hillshade: false");
    expect(arg).toContain("roads: false");
    expect(arg).toContain("labels: false");
  });

  test("the override spreads the stored set first, so every OTHER layer preference is untouched", () => {
    const match = src.match(/setLayers\((\{[^}]*\})\)/);
    expect(match).not.toBeNull();
    // "...stored" must appear before the four forced keys, not after — an
    // object spread after them would let a stored "satellite: true" win back.
    const body = match![1];
    const spreadAt = body.indexOf("...stored");
    const satelliteAt = body.indexOf("satellite: false");
    expect(spreadAt).toBeGreaterThan(-1);
    expect(satelliteAt).toBeGreaterThan(spreadAt);
  });

  test("saveLayers is untouched — a layer turned on mid-session still persists as a normal preference", () => {
    expect(src).toMatch(/if \(layersLoaded\.current\) void saveLayers\(layers\);/);
  });

  test("no other layer key is force-reset — this is a targeted fix, not a blanket one", () => {
    const forced = ["satellite", "hillshade", "roads", "labels"];
    const untouched = [
      "geology", "faults", "contacts", "lineaments", "occurrences", "terrain",
      "slope", "aspect", "drainage", "land", "geologyLabels", "waypoints",
      "track", "target", "accuracy", "compass", "grid",
    ];
    const match = src.match(/setLayers\((\{[^}]*\})\)/);
    const body = match![1];
    for (const key of untouched) {
      expect(body).not.toContain(`${key}: false`);
      expect(body).not.toContain(`${key}: true`);
    }
    for (const key of forced) {
      expect(body).toContain(`${key}: false`);
    }
  });
});

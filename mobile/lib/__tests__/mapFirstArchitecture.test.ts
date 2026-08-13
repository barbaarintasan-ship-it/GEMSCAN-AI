// Slice 1 — the map is the operating system.
//
// Architecture v2 §0.2 says no navigation may unmount the map, the exploration
// session or the GPS watch. That is a property of where things are MOUNTED, and
// it is undone silently: someone adds a map to a screen "just for this view",
// or a flow does `router.replace` back to the workspace and mounts a second one,
// and nothing fails — the app simply starts losing sessions again, which is
// exactly the bug the user reported in the field.
//
// So the structure is asserted here. These tests read source, which is unusual
// and deliberate: the invariant is architectural, and there is no runtime
// assertion that can catch a map mounted in the wrong place.
import * as fs from "fs";
import * as path from "path";
import { putAnalysedSample, takeAnalysedSample } from "../exploration/analysisHandoff";

const APP = path.join(__dirname, "..", "..", "app", "(app)");
const read = (p: string) => fs.readFileSync(path.join(APP, p), "utf8");

/**
 * Source with its comments removed.
 *
 * These files explain themselves at length, and the prose names the very
 * identifiers being asserted — the first `<Slot/>` in the layout is in a comment
 * about why it is a Slot. Structure is checked against code, not commentary.
 */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the session outlives every route", () => {
  // The providers were moved OUT of the explore route: mounted there, the back
  // arrow unmounted them and the provider teardown called orchestrator.destroy(),
  // ending the expedition and stopping the GPS watch. Above the router they live
  // for the life of the app process, which is what the field asked for.
  const rootLayout = fs.readFileSync(path.join(APP, "..", "_layout.tsx"), "utf8");

  test("the ROOT layout mounts the session and the workspace", () => {
    expect(rootLayout).toContain("ExplorationProvider");
    expect(rootLayout).toContain("MapWorkspaceProvider");
  });

  test("the providers wrap the router, not the other way round", () => {
    const src = code(rootLayout);
    const provider = src.indexOf("<ExplorationProvider>");
    const slot = src.indexOf("<Slot />");
    const close = src.indexOf("</ExplorationProvider>");
    expect(provider).toBeGreaterThan(-1);
    expect(slot).toBeGreaterThan(provider);
    expect(close).toBeGreaterThan(slot);
  });

  test("the explore route mounts NO provider — that is what used to kill the session", () => {
    const src = code(read(path.join("explore", "_layout.tsx")));
    expect(src).not.toContain("ExplorationProvider");
    expect(src).not.toContain("MapWorkspaceProvider");
  });
});

describe("the map lives in the layout, not in a screen", () => {
  const layout = read(path.join("explore", "_layout.tsx"));
  const surface = read(path.join("explore", "index.tsx"));

  test("the layout mounts the map host", () => {
    expect(layout).toContain("MapWorkspace");
  });

  test("the layout renders the router's children INSIDE the map host", () => {
    // <MapWorkspace> … <Slot/> … </MapWorkspace> — children float on the map.
    const src = code(layout);
    const open = src.indexOf("<MapWorkspace>");
    const slot = src.indexOf("<Slot");
    const close = src.indexOf("</MapWorkspace>");
    expect(open).toBeGreaterThan(-1);
    expect(slot).toBeGreaterThan(open);
    expect(close).toBeGreaterThan(slot);
  });

  test("the sheet surface never mounts a map of its own", () => {
    const src = code(surface);
    expect(src).not.toContain("ExplorationMap");
    expect(src).not.toContain("buildScene");
    expect(src).not.toContain("useMapTiles");
  });

  test("the surface reads the map through the workspace instead of owning it", () => {
    expect(surface).toContain("useMapWorkspace");
    // It drives the live map by handle — centre, frame — without holding the ref.
    expect(surface).toContain("mapRef.current");
  });
});

describe("returning from capture lands on the SAME map", () => {
  const newSample = read(path.join("enterprise", "new-sample.tsx"));

  test("the capture flow pops back rather than replacing the workspace", () => {
    // `replace` mounted a second exploration screen — a second provider and a
    // second GPS watch — on top of the one that had been running all along.
    expect(newSample).not.toMatch(/router\.replace\(\s*\{\s*pathname:\s*["'`]\/\(app\)\/explor/);
    expect(newSample).toContain("putAnalysedSample");
    expect(newSample).toContain("router.back()");
  });
});

describe("the old route still works", () => {
  const compat = read("exploration.tsx");

  test("it redirects to the workspace and forwards its parameters", () => {
    expect(compat).toContain("Redirect");
    expect(compat).toContain("/(app)/explore");
    // `?analysed=<id>` must survive, or a sample submitted by an older build
    // never gets folded back into the session.
    expect(compat).toContain("params");
  });
});

describe("analysisHandoff", () => {
  test("a submitted sample is handed over exactly once", () => {
    putAnalysedSample("sample-1");
    expect(takeAnalysedSample()).toBe("sample-1");
    // Draining on read is what stops a re-render folding the same evidence twice.
    expect(takeAnalysedSample()).toBeNull();
  });

  test("nothing pending reads as nothing", () => {
    expect(takeAnalysedSample()).toBeNull();
  });

  test("the last submission wins — there is only ever one in flight", () => {
    putAnalysedSample("a");
    putAnalysedSample("b");
    expect(takeAnalysedSample()).toBe("b");
  });
});

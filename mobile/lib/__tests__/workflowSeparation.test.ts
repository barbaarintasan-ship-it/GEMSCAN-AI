// Personal samples and exploration missions are two workflows, not one.
//
// WHAT WENT WRONG
//
// `enterprise.sample` served both a geologist's personal collection and a field
// mission's evidence, with nothing recording which was which. `analyze-sample`
// runs the GeoContext spatial providers for every sample, so a rock photographed
// at home was given a mapped-geology reading, nearby-occurrence evidence and a
// structural context for wherever the phone happened to be standing. A private
// collection was being told things about prospectivity that nobody asked it to
// say, and that its owner had no way to check.
//
// The separation is enforced in three places — the database (`sample.origin`),
// the analysis (`buildKnowledgeProviders`), and the screens. This file pins the
// screen half, because that is the half that regresses silently: someone adds a
// list, forgets the filter, and nothing fails.
import * as fs from "fs";
import * as path from "path";

const MOBILE = path.join(__dirname, "..", "..");
const read = (...p: string[]) => fs.readFileSync(path.join(MOBILE, ...p), "utf8");

/** Source with comments stripped — the prose names the very identifiers asserted. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("My Samples shows personal samples, and only those", () => {
  test("the list asks the server for the personal workflow", () => {
    // Filtered in the QUERY, not on the device. A screen that fetched both and
    // hid one would still have pulled a mission's evidence into a personal
    // collection.
    const src = code(read("app", "(app)", "enterprise", "samples.tsx"));
    expect(src).toMatch(/listSamples\(\s*"personal"\s*\)/);
  });

  test("the fetch helper can carry an origin at all", () => {
    const src = code(read("lib", "enterpriseSamples.ts"));
    expect(src).toMatch(/origin\?:\s*"personal"\s*\|\s*"exploration"/);
    expect(src).toContain("?origin=");
  });
});

describe("a sample states which workflow it belongs to", () => {
  const src = code(read("app", "(app)", "enterprise", "new-sample.tsx"));

  test("origin is decided at capture, from how the screen was reached", () => {
    // Deriving it on the server from whether an expedition happened to be open
    // would file a rock picked up on the way home as mission evidence.
    expect(src).toMatch(/origin:\s*fromExploration\s*\?\s*"exploration"\s*:\s*"personal"/);
  });

  test("the mission id travels with an exploration sample", () => {
    expect(src).toContain("field_mission_id");
    expect(src).toContain("currentMissionId()");
  });

  test("a personal sample carries NO mission id", () => {
    expect(src).toMatch(/field_mission_id:\s*fromExploration\s*\?\s*currentMissionId\(\)\s*:\s*null/);
  });
});

describe("the mission a sample belongs to is knowable", () => {
  test("the running mission is published, not derived from the session", () => {
    // A walk can contain several missions. Deriving from the session id is the
    // defect that once attached one target's rock to another target's package.
    const src = code(read("lib", "exploration", "currentExpedition.ts"));
    expect(src).toContain("setCurrentMission");
    expect(src).toContain("currentMissionId");
  });

  test("the orchestrator publishes it whenever the mission changes", () => {
    const src = code(read("lib", "exploration", "orchestrator.ts"));
    expect(src).toContain("setCurrentMission");
  });

  test("it is cleared when no mission is live", () => {
    const src = code(read("lib", "exploration", "orchestrator.ts"));
    const call = src.match(/setCurrentMission\(.*\);/)?.[0] ?? "";
    expect(call).toContain("isMissionLive");
    expect(call).toContain("null");
  });
});

describe("the two workflows have two destinations", () => {
  const dash = code(read("app", "(app)", "enterprise", "index.tsx"));

  test("the dashboard offers exploration and samples separately", () => {
    expect(dash).toContain("/(app)/enterprise/reports");
    expect(dash).toContain("/(app)/enterprise/samples");
  });

  test("starting an investigation is the primary action", () => {
    expect(dash).toContain("/(app)/explore");
  });

  test("the reports list never renders a personal sample", () => {
    // It reads the package store — missions the device built. There is no path
    // from here to the sample tables at all, which is the strongest form the
    // separation can take.
    const src = code(read("app", "(app)", "enterprise", "reports.tsx"));
    expect(src).not.toContain("listSamples");
    expect(src).not.toContain("enterpriseSamples");
    expect(src).toContain("useExploration");
  });
});

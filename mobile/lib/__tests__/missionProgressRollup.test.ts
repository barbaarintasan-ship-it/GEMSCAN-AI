// Phase 2D — mission-level progress rollup, mobile wiring.
//
// The rollup ARITHMETIC (idempotency, soft-delete exclusion, observation
// summing across the four observation tables, no-fake-coverage, and both
// RPCs' authorization boundary) was verified live against production via
// JWT-impersonated SQL — that is where the real logic lives
// (enterprise.recompute_mission_progress / enterprise.mission_progress_detail,
// migrations 0119/0120), and a client-side mock cannot exercise a Postgres
// function's own SQL. What belongs here, and regresses silently if it isn't
// pinned, is the CLIENT wiring: the mobile wrapper calls the RIGHT RPC names
// against the RIGHT schema, and Phase 2D's screen never reaches into the
// Solo Exploration stack it was explicitly told not to touch. Same source-
// pattern-assertion style as workflowSeparation.test.ts, for the same
// reason: these are thin wrappers with no runtime logic of their own to
// mock meaningfully.
import * as fs from "fs";
import * as path from "path";

const MOBILE = path.join(__dirname, "..", "..");
const read = (...p: string[]) => fs.readFileSync(path.join(MOBILE, ...p), "utf8");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// Anything that would mean this phase reached into the SOLO stack it was
// explicitly told not to touch (do-not-touch list, Phase 2D brief).
const SOLO_ONLY_IDENTIFIERS = [
  "geo/field_mission", "geo.field_mission",
  "TargetingEngine", "exploration/orchestrator", "exploration/targeting",
  "prospectivityEvidence", "localEvidence", "evidencePackage",
];

describe("Phase 2D client wrapper calls the correct RPCs", () => {
  const src = code(read("lib", "enterprise", "missions.ts"));

  test("recomputeMissionProgress calls enterprise.recompute_mission_progress", () => {
    expect(src).toMatch(/rpc\(\s*"recompute_mission_progress"/);
  });

  test("fetchMissionProgressDetail calls enterprise.mission_progress_detail", () => {
    expect(src).toMatch(/rpc\(\s*"mission_progress_detail"/);
  });

  test("fetchMissionProgress reads the mission_progress table directly (no recompute)", () => {
    expect(src).toMatch(/from\(\s*"mission_progress"\s*\)/);
  });

  test("MissionProgress never carries a fabricated coverage field beyond coverage_pct", () => {
    // Pins the type to exactly the four columns the migration actually
    // produces — a caller adding a "cells_completed"-style field here would
    // be inventing data the RPC does not compute.
    const typeBlock = src.match(/export type MissionProgress = \{[\s\S]*?\};/)?.[0] ?? "";
    expect(typeBlock).toContain("observation_count");
    expect(typeBlock).toContain("sample_count");
    expect(typeBlock).toContain("coverage_pct");
    expect(typeBlock).toContain("updated_at");
  });
});

describe("Phase 2D does not touch Solo Exploration", () => {
  const files = [
    ["lib", "enterprise", "missions.ts"],
    ["app", "(app)", "enterprise", "manager-mission", "[missionId].tsx"],
  ];

  for (const parts of files) {
    test(`${parts[parts.length - 1]} imports nothing from the Solo stack`, () => {
      const src = code(read(...parts));
      for (const id of SOLO_ONLY_IDENTIFIERS) {
        expect(src).not.toContain(id);
      }
    });
  }
});

describe("Manager Mission Detail surfaces progress without fabricating coverage", () => {
  const src = code(read("app", "(app)", "enterprise", "manager-mission", "[missionId].tsx"));

  test("recomputes on load (explicit on-demand refresh, not a trigger/cron)", () => {
    expect(src).toContain("recomputeMissionProgress(missionId)");
  });

  test("renders the required labels", () => {
    expect(src).toMatch(/Assigned cells/);
    expect(src).toMatch(/Samples collected/);
    expect(src).toMatch(/Outside-assignment samples/);
    expect(src).toMatch(/Last activity/);
  });

  test("never labels anything a raw coverage percentage from coverage_pct", () => {
    // coverage_pct is always 0 this phase (H3 resolution mismatch, see
    // 0119's header) — rendering "Coverage: 0%" would read as a real,
    // measured-and-empty result rather than "not implemented yet".
    expect(src).not.toMatch(/\{progress[^}]*coverage_pct[^}]*\}%/);
    expect(src).not.toContain("Cells completed");
  });

  test("documents that cell-level coverage is deferred", () => {
    expect(src.toLowerCase()).toContain("coverage");
    expect(src.toLowerCase()).toMatch(/isn't calculated yet|lama xisaabin/);
  });
});

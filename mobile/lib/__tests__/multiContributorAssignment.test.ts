// Phase 4 (Solo→Team shared-targeting) — Multi-Contributor Assignment.
//
// The RPC ARITHMETIC (additive assign, idempotent re-assign, unassign
// preserving the canonical row/score/other contributors, unauthorized
// rejection, audit trail) was verified live against production via
// JWT-impersonated SQL — same reason missionProgressRollup.test.ts gives for
// doing the same thing with Phase 2D's RPCs: a client-side mock cannot
// exercise a Postgres function's own SQL. What belongs here is what has real
// logic on the CLIENT: `groupMissionCells()` (pure, deterministic, no
// network — a real unit-test target), and source-pattern pins on the UI/
// wrapper wiring, in the same style workflowSeparation.test.ts and
// missionProgressRollup.test.ts already use for thin RPC wrappers.
import * as fs from "fs";
import * as path from "path";
import { groupMissionCells } from "../enterprise/missionCellGrouping";
import type { Assignment } from "../enterprise/missions";

const MOBILE = path.join(__dirname, "..", "..");
const read = (...p: string[]) => fs.readFileSync(path.join(MOBILE, ...p), "utf8");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function row(overrides: Partial<Assignment>): Assignment {
  return {
    id: "row-" + Math.random().toString(36).slice(2),
    target_h3: "877a1c284ffffff",
    contributor_id: null,
    status: "assigned",
    due_at: null,
    area_id: "area-1",
    created_at: "2026-01-01T00:00:00.000Z",
    prospectivity_score: null,
    scored_at: null,
    ...overrides,
  };
}

describe("groupMissionCells — [U] groups multiple contributor rows under one H3", () => {
  test("a cell with three contributors produces exactly ONE group, not three", () => {
    const rows = [
      row({ id: "pool", target_h3: "AAA", contributor_id: null, prospectivity_score: 0.82 }),
      row({ id: "a1", target_h3: "AAA", contributor_id: "ahmed" }),
      row({ id: "a2", target_h3: "AAA", contributor_id: "hassan" }),
      row({ id: "a3", target_h3: "AAA", contributor_id: "yusuf" }),
    ];
    const groups = groupMissionCells(rows);
    expect(groups.length).toBe(1);
    expect(groups[0].targetH3).toBe("AAA");
    expect(groups[0].contributors.map((c) => c.contributor_id).sort()).toEqual(["ahmed", "hassan", "yusuf"]);
  });

  test("[L] the canonical (contributor_id null) row's fields become the group's cell intelligence", () => {
    const rows = [
      row({ id: "pool", target_h3: "AAA", contributor_id: null, prospectivity_score: 0.82, scored_at: "2026-02-01T00:00:00.000Z", area_id: "area-9" }),
      row({ id: "a1", target_h3: "AAA", contributor_id: "ahmed" }),
    ];
    const group = groupMissionCells(rows)[0];
    expect(group.prospectivityScore).toBe(0.82);
    expect(group.scoredAt).toBe("2026-02-01T00:00:00.000Z");
    expect(group.areaId).toBe("area-9");
    expect(group.cellId).toBe("pool");
  });

  test("a cell with zero contributors still produces a group — 'ranked, nobody assigned' is a real state", () => {
    const rows = [row({ id: "pool", target_h3: "BBB", contributor_id: null, prospectivity_score: 0.5 })];
    const groups = groupMissionCells(rows);
    expect(groups.length).toBe(1);
    expect(groups[0].contributors).toEqual([]);
    expect(groups[0].prospectivityScore).toBe(0.5);
  });
});

describe("groupMissionCells — [V] ranking is one rank per H3, by score, deterministic ties", () => {
  test("groups sort by prospectivityScore descending, not by row count", () => {
    const rows = [
      // Cell LOW scores 0.2 but has three contributor rows — must not out-rank HIGH.
      row({ id: "pool-low", target_h3: "LOW", contributor_id: null, prospectivity_score: 0.2 }),
      row({ id: "low-a", target_h3: "LOW", contributor_id: "a" }),
      row({ id: "low-b", target_h3: "LOW", contributor_id: "b" }),
      row({ id: "low-c", target_h3: "LOW", contributor_id: "c" }),
      row({ id: "pool-high", target_h3: "HIGH", contributor_id: null, prospectivity_score: 0.9 }),
    ];
    const groups = groupMissionCells(rows);
    expect(groups.map((g) => g.targetH3)).toEqual(["HIGH", "LOW"]);
  });

  test("unscored cells (null) sort last, never treated as zero", () => {
    const rows = [
      row({ id: "p1", target_h3: "SCORED", contributor_id: null, prospectivity_score: 0.1 }),
      row({ id: "p2", target_h3: "UNSCORED", contributor_id: null, prospectivity_score: null }),
    ];
    const groups = groupMissionCells(rows);
    expect(groups.map((g) => g.targetH3)).toEqual(["SCORED", "UNSCORED"]);
  });

  test("equal scores tie-break on target_h3 alone — no invented geological weighting", () => {
    const rows = [
      row({ id: "p1", target_h3: "ZEBRA", contributor_id: null, prospectivity_score: 0.5 }),
      row({ id: "p2", target_h3: "ALPHA", contributor_id: null, prospectivity_score: 0.5 }),
    ];
    const groups = groupMissionCells(rows);
    expect(groups.map((g) => g.targetH3)).toEqual(["ALPHA", "ZEBRA"]);
  });

  test("grouping+ranking is stable across multiple cells mixed with multiple contributors", () => {
    const rows = [
      row({ id: "p-b", target_h3: "B", contributor_id: null, prospectivity_score: 0.6 }),
      row({ id: "b-x", target_h3: "B", contributor_id: "x" }),
      row({ id: "p-a", target_h3: "A", contributor_id: null, prospectivity_score: 0.9 }),
      row({ id: "a-x", target_h3: "A", contributor_id: "x" }),
      row({ id: "a-y", target_h3: "A", contributor_id: "y" }),
      row({ id: "p-c", target_h3: "C", contributor_id: null, prospectivity_score: null }),
    ];
    const groups = groupMissionCells(rows);
    expect(groups.map((g) => [g.targetH3, g.contributors.length])).toEqual([
      ["A", 2], ["B", 1], ["C", 0],
    ]);
  });
});

describe("Phase 4 client wiring calls the correct RPCs (same style as missionProgressRollup.test.ts)", () => {
  const src = code(read("lib", "enterprise", "missions.ts"));

  test("unassignMissionCellContributor calls enterprise.unassign_mission_cell_contributor", () => {
    expect(src).toMatch(/rpc\(\s*"unassign_mission_cell_contributor"/);
  });

  test("assignCells still calls enterprise.assign_mission_cells (RPC name unchanged — behavior changed server-side only)", () => {
    expect(src).toMatch(/rpc\(\s*"assign_mission_cells"/);
  });
});

describe("Manager Mission screen renders grouped cells, not raw assignment rows", () => {
  const src = code(read("app", "(app)", "enterprise", "manager-mission", "[missionId].tsx"));

  test("uses groupMissionCells for the H3 cell list", () => {
    expect(src).toContain("groupMissionCells(cells)");
  });

  test("the destructive-sounding 'Reassign?' prompt is gone", () => {
    expect(src).not.toMatch(/Reassign\?/);
  });

  test("assigning an additional contributor and removing one are both present and distinct", () => {
    expect(src).toContain("handleAssignAlso");
    expect(src).toContain("handleUnassign");
  });
});

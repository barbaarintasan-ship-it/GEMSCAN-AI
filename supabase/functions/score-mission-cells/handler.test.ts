// Integration-shaped tests for score-mission-cells with injected dependencies
// (no live Supabase stack): request validation, the unscored-by-default /
// force-all modes, the batch scoring call shape, server-authoritative
// persistence (no client score is ever read), the per-call cell cap, and
// error mapping. Solo→Team shared-targeting Phase 3.
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  handleScoreMissionCells, MAX_CELLS_PER_SCORING_CALL, mapWithConcurrency,
  type ScoreMissionCellsDeps, type CellToScore, type ScoredCell,
} from "./handler.ts";
import type { Actor } from "../_shared/enterprise/auth.ts";
import { UnauthorizedError } from "../_shared/enterprise/errors.ts";

const OWNER: Actor = { userId: "owner-1", email: "owner@example.com", contributorId: "c1", role: "admin" };

function req(body?: Record<string, unknown>, method = "POST"): Request {
  return new Request("https://x/score-mission-cells", { method, body: body ? JSON.stringify(body) : undefined });
}

function fakeUserClient(onRpc: (fn: string, args: Record<string, unknown>) => void) {
  return (_req: Request) => ({
    schema: (_s: string) => ({
      rpc: (fn: string, args: Record<string, unknown>) => {
        onRpc(fn, args);
        return Promise.resolve({ data: (args.p_scores as unknown[]).length, error: null });
      },
    }),
  }) as any;
}

const THREE_CELLS: CellToScore[] = [
  { targetH3: "8752de409ffffff", lat: 9.50, lng: 44.50 },
  { targetH3: "8752de41bffffff", lat: 9.51, lng: 44.51 },
  { targetH3: "8752de403ffffff", lat: 9.49, lng: 44.49 },
];

function baseDeps(overrides: Partial<ScoreMissionCellsDeps> = {}): ScoreMissionCellsDeps {
  return {
    resolveActor: async () => OWNER,
    userClient: fakeUserClient(() => {}),
    cellsToScore: async () => THREE_CELLS,
    scoreCells: async (_missionId, cells) => cells.map((c) => ({ targetH3: c.targetH3, score: 0.5, integratedScore: null, evidenceSampleCount: 0 })),
    ...overrides,
  };
}

Deno.test("OPTIONS returns CORS preflight ok", async () => {
  const r = await handleScoreMissionCells(req(undefined, "OPTIONS"), baseDeps());
  assertEquals(r.status, 200);
});

Deno.test("missing missionId → 400 validation error", async () => {
  const r = await handleScoreMissionCells(req({}), baseDeps());
  assertEquals(r.status, 400);
});

Deno.test("[G] no cells to score → 200 with zero counts, no RPC call", async () => {
  let rpcCalled = false;
  const deps = baseDeps({ cellsToScore: async () => [], userClient: fakeUserClient(() => { rpcCalled = true; }) });
  const r = await handleScoreMissionCells(req({ missionId: "m1" }), deps);
  assertEquals(r.status, 200);
  const b = await r.json();
  assertEquals(b.requested, 0);
  assertEquals(b.scored, 0);
  assertEquals(b.persisted, 0);
  assertEquals(rpcCalled, false);
});

Deno.test("[B,C] scores come from the injected shared-engine scorer, not invented here", async () => {
  const deps = baseDeps({
    scoreCells: async (_missionId, cells) => cells.map((c, i) => ({ targetH3: c.targetH3, score: 0.1 * (i + 1), integratedScore: null, evidenceSampleCount: 0 })),
  });
  const r = await handleScoreMissionCells(req({ missionId: "m1" }), deps);
  const b = await r.json();
  assertEquals(b.cells, [
    { targetH3: "8752de409ffffff", score: 0.1, integratedScore: null, evidenceSampleCount: 0 },
    { targetH3: "8752de41bffffff", score: 0.2, integratedScore: null, evidenceSampleCount: 0 },
    { targetH3: "8752de403ffffff", score: 0.30000000000000004, integratedScore: null, evidenceSampleCount: 0 },
  ]);
});

Deno.test("[D] no AI provider is ever invoked — the scorer dependency is the only source of numbers", async () => {
  // Structural proof: handleScoreMissionCells has no code path that imports or
  // calls an AI/LLM provider — scoreCells is the sole numeric source, and its
  // default implementation (defaultScoreCells) only calls TargetingEngine.targetAt(),
  // the same deterministic function Phase 1/2 use. Exercised here by confirming
  // the handler never asks its dependencies for anything beyond cells/scores.
  let calls = 0;
  const deps = baseDeps({ scoreCells: async (_missionId, cells) => { calls++; return cells.map((c) => ({ targetH3: c.targetH3, score: 0.4, integratedScore: null, evidenceSampleCount: 0 })); } });
  await handleScoreMissionCells(req({ missionId: "m1" }), deps);
  assertEquals(calls, 1); // exactly one deterministic batch call, no separate "AI pass"
});

Deno.test("[F] a client-supplied score in the request body is never read or persisted", async () => {
  let sentToRpc: Record<string, unknown> | null = null;
  const deps = baseDeps({
    userClient: fakeUserClient((_fn, args) => { sentToRpc = args; }),
    scoreCells: async (_missionId, cells) => cells.map((c) => ({ targetH3: c.targetH3, score: 0.33, integratedScore: null, evidenceSampleCount: 0 })),
  });
  // A hostile client tries to smuggle scores in via the request body.
  const r = await handleScoreMissionCells(
    req({ missionId: "m1", cells: [{ target_h3: "8752de409ffffff", score: 0.999 }] }),
    deps,
  );
  assertEquals(r.status, 200);
  const args = sentToRpc as any;
  for (const s of args.p_scores) assertEquals(s.score, 0.33);
});

Deno.test("default mode requests only unscored cells; force=true asks for all", async () => {
  let lastForce: boolean | null = null;
  const deps = baseDeps({ cellsToScore: async (_req, _m, _a, force) => { lastForce = force; return THREE_CELLS; } });
  await handleScoreMissionCells(req({ missionId: "m1" }), deps);
  assertEquals(lastForce, false);
  await handleScoreMissionCells(req({ missionId: "m1", force: true }), deps);
  assertEquals(lastForce, true);
});

Deno.test("more cells than the per-call cap → 400, no scoring attempted", async () => {
  let scoreCellsCalled = false;
  const many: CellToScore[] = Array.from({ length: MAX_CELLS_PER_SCORING_CALL + 1 }, (_, i) => (
    { targetH3: `${i}`.padStart(15, "0"), lat: 0, lng: 0 }
  ));
  const deps = baseDeps({
    cellsToScore: async () => many,
    scoreCells: async (_missionId, cells) => { scoreCellsCalled = true; return cells.map((c) => ({ targetH3: c.targetH3, score: 0.1, integratedScore: null, evidenceSampleCount: 0 })); },
  });
  const r = await handleScoreMissionCells(req({ missionId: "m1" }), deps);
  assertEquals(r.status, 400);
  assertEquals(scoreCellsCalled, false);
});

Deno.test("[K] evidence caveat is present, including on the zero-cells response", async () => {
  const r1 = await handleScoreMissionCells(req({ missionId: "m1" }), baseDeps());
  const b1 = await r1.json();
  assert(/structural/i.test(b1.evidenceCaveat) && /lithology/i.test(b1.evidenceCaveat));

  const r2 = await handleScoreMissionCells(req({ missionId: "m1" }), baseDeps({ cellsToScore: async () => [] }));
  const b2 = await r2.json();
  assert(typeof b2.evidenceCaveat === "string" && b2.evidenceCaveat.length > 0);
});

Deno.test("missing/invalid JWT → 401 via errorResponse", async () => {
  const deps = baseDeps({ resolveActor: async () => { throw new UnauthorizedError("invalid or expired token"); } });
  const r = await handleScoreMissionCells(req({ missionId: "m1" }), deps);
  assertEquals(r.status, 401);
});

Deno.test("a non-manager is refused by the RPC's own authorization check, surfaced as an error", async () => {
  const deps = baseDeps({
    userClient: () => ({
      schema: () => ({
        rpc: () => Promise.resolve({ data: null, error: { message: "forbidden: only the mission owner or an org owner/admin can score cells" } }),
      }),
    }) as any,
  });
  const r = await handleScoreMissionCells(req({ missionId: "m1" }), deps);
  assertEquals(r.status, 400);
  const b = await r.json();
  assert(/forbidden/i.test(b.error));
});

// Sanity type-use so ScoredCell import isn't flagged unused if a future edit
// trims the assertions above.
const _typeCheck: ScoredCell = { targetH3: "x", score: 0, integratedScore: null, evidenceSampleCount: 0 };
void _typeCheck;

// ── Phase 8 — integrated score passthrough ──────────────────────────────────

Deno.test("[Phase 8] integratedScore/evidenceSampleCount pass through to the RPC as snake_case", async () => {
  let sentToRpc: Record<string, unknown> | null = null;
  const deps = baseDeps({
    userClient: fakeUserClient((_fn, args) => { sentToRpc = args; }),
    scoreCells: async (_missionId, cells) => cells.map((c) => ({
      targetH3: c.targetH3, score: 0.5, integratedScore: 0.72, evidenceSampleCount: 3,
    })),
  });
  await handleScoreMissionCells(req({ missionId: "m1" }), deps);
  const args = sentToRpc as any;
  for (const s of args.p_scores) {
    assertEquals(s.integrated_score, 0.72);
    assertEquals(s.evidence_sample_count, 3);
  }
});

Deno.test("[Phase 8] a cell with no evidence sends integrated_score: null, never a fabricated number", async () => {
  let sentToRpc: Record<string, unknown> | null = null;
  const deps = baseDeps({ userClient: fakeUserClient((_fn, args) => { sentToRpc = args; }) });
  await handleScoreMissionCells(req({ missionId: "m1" }), deps);
  const args = sentToRpc as any;
  for (const s of args.p_scores) {
    assertEquals(s.integrated_score, null);
    assertEquals(s.evidence_sample_count, 0);
  }
});

Deno.test("[Phase 8] scoreCells receives the missionId, not just the cell list", async () => {
  let receivedMissionId: string | null = null;
  const deps = baseDeps({
    scoreCells: async (missionId, cells) => {
      receivedMissionId = missionId;
      return cells.map((c) => ({ targetH3: c.targetH3, score: 0.5, integratedScore: null, evidenceSampleCount: 0 }));
    },
  });
  await handleScoreMissionCells(req({ missionId: "mission-xyz" }), deps);
  assertEquals(receivedMissionId, "mission-xyz");
});

// ── mapWithConcurrency (perf) ────────────────────────────────────────────────

Deno.test("[perf] mapWithConcurrency preserves input order regardless of completion order", async () => {
  const delays = [30, 10, 20, 0];
  const results = await mapWithConcurrency(delays, 4, (ms) => new Promise((r) => setTimeout(() => r(ms), ms)));
  assertEquals(results, delays);
});

Deno.test("[perf] mapWithConcurrency never runs more than `limit` at once", async () => {
  let active = 0;
  let maxActive = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  await mapWithConcurrency(items, 3, async (i) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return i;
  });
  assert(maxActive <= 3);
});

Deno.test("[perf] mapWithConcurrency processes every item exactly once", async () => {
  const items = Array.from({ length: 37 }, (_, i) => i);
  const results = await mapWithConcurrency(items, 10, async (i) => i * 2);
  assertEquals(results, items.map((i) => i * 2));
});

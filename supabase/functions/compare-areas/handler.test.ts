// Integration-shaped tests for compare-areas with injected dependencies (no
// live Supabase stack): request validation, the RPC call shape, error
// mapping, and spoofing-resistance (the handler forwards only the validated
// missionId/areaIdA/areaIdB it parsed, nothing else from the body).
// Phase 12 (Geological Intelligence Transformation).
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleCompareAreas, type CompareAreasDeps } from "./handler.ts";
import type { Actor } from "../_shared/enterprise/auth.ts";
import { UnauthorizedError } from "../_shared/enterprise/errors.ts";

const OWNER: Actor = { userId: "owner-1", email: "owner@example.com", contributorId: "c1", role: "admin" };

function req(body?: Record<string, unknown>, method = "POST"): Request {
  return new Request("https://x/compare-areas", { method, body: body ? JSON.stringify(body) : undefined });
}

const FAKE_RESULT = {
  area_a: { area_id: "a1", name: "Area A", score: 0.72 },
  area_b: { area_id: "b1", name: "Area B", score: 0.41 },
  diff: { score_delta: 0.31, roles_only_in_a: ["structural"], roles_only_in_b: [], reason_kinds_only_in_a: ["fault"], reason_kinds_only_in_b: [] },
};

function fakeUserClient(onRpc: (fn: string, args: Record<string, unknown>) => void) {
  return (_req: Request) => ({
    schema: (_s: string) => ({
      rpc: (fn: string, args: Record<string, unknown>) => {
        onRpc(fn, args);
        return Promise.resolve({ data: FAKE_RESULT, error: null });
      },
    }),
  }) as any;
}

function baseDeps(overrides: Partial<CompareAreasDeps> = {}): CompareAreasDeps {
  return {
    resolveActor: async () => OWNER,
    userClient: fakeUserClient(() => {}),
    ...overrides,
  };
}

Deno.test("OPTIONS returns CORS preflight ok", async () => {
  const r = await handleCompareAreas(req(undefined, "OPTIONS"), baseDeps());
  assertEquals(r.status, 200);
});

Deno.test("missing missionId/areaIdA/areaIdB → 400 validation errors", async () => {
  const r1 = await handleCompareAreas(req({ areaIdA: "a1", areaIdB: "b1" }), baseDeps());
  assertEquals(r1.status, 400);
  const r2 = await handleCompareAreas(req({ missionId: "m1", areaIdB: "b1" }), baseDeps());
  assertEquals(r2.status, 400);
  const r3 = await handleCompareAreas(req({ missionId: "m1", areaIdA: "a1" }), baseDeps());
  assertEquals(r3.status, 400);
});

Deno.test("comparing an area to itself is refused before any RPC call", async () => {
  let rpcCalled = false;
  const deps = baseDeps({ userClient: fakeUserClient(() => { rpcCalled = true; }) });
  const r = await handleCompareAreas(req({ missionId: "m1", areaIdA: "a1", areaIdB: "a1" }), deps);
  assertEquals(r.status, 400);
  assertEquals(rpcCalled, false);
});

Deno.test("missionId/areaIdA/areaIdB reach the RPC unchanged, and only those fields", async () => {
  let sentToRpc: Record<string, unknown> | null = null;
  const deps = baseDeps({ userClient: fakeUserClient((fn, args) => { assertEquals(fn, "compare_mission_areas"); sentToRpc = args; }) });
  const r = await handleCompareAreas(req({ missionId: "mission-42", areaIdA: "area-a", areaIdB: "area-b" }), deps);
  assertEquals(r.status, 200);
  const args = sentToRpc as any;
  assertEquals(args.p_mission, "mission-42");
  assertEquals(args.p_area_a, "area-a");
  assertEquals(args.p_area_b, "area-b");
  assertEquals(Object.keys(args).sort(), ["p_area_a", "p_area_b", "p_mission"]);
});

Deno.test("the RPC's structured diff is returned verbatim, never recomputed here", async () => {
  const r = await handleCompareAreas(req({ missionId: "m1", areaIdA: "a1", areaIdB: "b1" }), baseDeps());
  const b = await r.json();
  assertEquals(b, FAKE_RESULT);
  assertEquals(b.diff.score_delta, 0.31);
});

Deno.test("missing/invalid JWT → 401 via errorResponse", async () => {
  const deps = baseDeps({ resolveActor: async () => { throw new UnauthorizedError("invalid or expired token"); } });
  const r = await handleCompareAreas(req({ missionId: "m1", areaIdA: "a1", areaIdB: "b1" }), deps);
  assertEquals(r.status, 401);
});

Deno.test("a non-member is refused by the RPC's own authorization check, surfaced as an error", async () => {
  const deps = baseDeps({
    userClient: (_req: Request) => ({
      schema: (_s: string) => ({
        rpc: (_fn: string, _args: Record<string, unknown>) =>
          Promise.resolve({ data: null, error: { message: "forbidden: only a member of this mission can compare its areas" } }),
      }),
    }) as any,
  });
  const r = await handleCompareAreas(req({ missionId: "m1", areaIdA: "a1", areaIdB: "b1" }), deps);
  assertEquals(r.status, 400);
  const b = await r.json();
  assert(/forbidden/i.test(b.error));
});

Deno.test("an area not belonging to the mission is refused by the RPC, surfaced as an error", async () => {
  const deps = baseDeps({
    userClient: (_req: Request) => ({
      schema: (_s: string) => ({
        rpc: (_fn: string, _args: Record<string, unknown>) =>
          Promise.resolve({ data: null, error: { message: "validation: area b1 does not belong to mission m1" } }),
      }),
    }) as any,
  });
  const r = await handleCompareAreas(req({ missionId: "m1", areaIdA: "a1", areaIdB: "b1" }), deps);
  assertEquals(r.status, 400);
});

// ── Security: a hostile client cannot inject anything beyond the 3 IDs ─────

Deno.test("[security] client-supplied score/reasons/coverage in the body are never read or forwarded — the RPC is the only source", async () => {
  let sentToRpc: Record<string, unknown> | null = null;
  const deps = baseDeps({ userClient: fakeUserClient((_fn, args) => { sentToRpc = args; }) });
  await handleCompareAreas(
    req({
      missionId: "m1", areaIdA: "a1", areaIdB: "b1",
      score_delta: 999, diff: { fabricated: true }, area_a: { score: 1 },
    }),
    deps,
  );
  const args = sentToRpc as any;
  assertEquals(Object.keys(args).sort(), ["p_area_a", "p_area_b", "p_mission"]);
});

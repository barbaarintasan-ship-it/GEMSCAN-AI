// Integration-shaped tests for target-report with injected dependencies (no
// live Supabase stack): request validation, the RPC call shape, error
// mapping, and spoofing-resistance. Phase 14 (Geological Intelligence
// Transformation).
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleTargetReport, type TargetReportDeps } from "./handler.ts";
import type { Actor } from "../_shared/enterprise/auth.ts";
import { UnauthorizedError } from "../_shared/enterprise/errors.ts";

const OWNER: Actor = { userId: "owner-1", email: "owner@example.com", contributorId: "c1", role: "admin" };

function req(body?: Record<string, unknown>, method = "POST"): Request {
  return new Request("https://x/target-report", { method, body: body ? JSON.stringify(body) : undefined });
}

const FAKE_REPORT = {
  mission_id: "m1",
  area: { area_id: "a1", name: "Area A", review_status: "accepted" },
  target: { target_h3: "8752de409ffffff", score: 0.66, reasons: [], coverage: null, evidence: null },
  ai_synthesis: { headline: "Two contributors agree", agreement: "consistent" },
};

function fakeUserClient(onRpc: (fn: string, args: Record<string, unknown>) => void) {
  return (_req: Request) => ({
    schema: (_s: string) => ({
      rpc: (fn: string, args: Record<string, unknown>) => {
        onRpc(fn, args);
        return Promise.resolve({ data: FAKE_REPORT, error: null });
      },
    }),
  }) as any;
}

function baseDeps(overrides: Partial<TargetReportDeps> = {}): TargetReportDeps {
  return {
    resolveActor: async () => OWNER,
    userClient: fakeUserClient(() => {}),
    ...overrides,
  };
}

Deno.test("OPTIONS returns CORS preflight ok", async () => {
  const r = await handleTargetReport(req(undefined, "OPTIONS"), baseDeps());
  assertEquals(r.status, 200);
});

Deno.test("missing missionId/areaId → 400 validation errors", async () => {
  const r1 = await handleTargetReport(req({ areaId: "a1" }), baseDeps());
  assertEquals(r1.status, 400);
  const r2 = await handleTargetReport(req({ missionId: "m1" }), baseDeps());
  assertEquals(r2.status, 400);
});

Deno.test("missionId/areaId reach the RPC unchanged, and only those fields", async () => {
  let sentToRpc: Record<string, unknown> | null = null;
  const deps = baseDeps({ userClient: fakeUserClient((fn, args) => { assertEquals(fn, "get_target_report"); sentToRpc = args; }) });
  const r = await handleTargetReport(req({ missionId: "mission-42", areaId: "area-7" }), deps);
  assertEquals(r.status, 200);
  const args = sentToRpc as any;
  assertEquals(args.p_mission, "mission-42");
  assertEquals(args.p_area, "area-7");
  assertEquals(Object.keys(args).sort(), ["p_area", "p_mission"]);
});

Deno.test("the RPC's assembled report is returned verbatim, never recomputed here", async () => {
  const r = await handleTargetReport(req({ missionId: "m1", areaId: "a1" }), baseDeps());
  const b = await r.json();
  assertEquals(b, FAKE_REPORT);
});

Deno.test("missing/invalid JWT → 401 via errorResponse", async () => {
  const deps = baseDeps({ resolveActor: async () => { throw new UnauthorizedError("invalid or expired token"); } });
  const r = await handleTargetReport(req({ missionId: "m1", areaId: "a1" }), deps);
  assertEquals(r.status, 401);
});

Deno.test("a non-member is refused by the RPC's own authorization check, surfaced as an error", async () => {
  const deps = baseDeps({
    userClient: (_req: Request) => ({
      schema: (_s: string) => ({
        rpc: (_fn: string, _args: Record<string, unknown>) =>
          Promise.resolve({ data: null, error: { message: "forbidden: only a member of this mission can view its target report" } }),
      }),
    }) as any,
  });
  const r = await handleTargetReport(req({ missionId: "m1", areaId: "a1" }), deps);
  assertEquals(r.status, 400);
  const b = await r.json();
  assert(/forbidden/i.test(b.error));
});

Deno.test("[security] client-supplied area/target/ai_synthesis fields are never read or forwarded", async () => {
  let sentToRpc: Record<string, unknown> | null = null;
  const deps = baseDeps({ userClient: fakeUserClient((_fn, args) => { sentToRpc = args; }) });
  await handleTargetReport(
    req({ missionId: "m1", areaId: "a1", target: { score: 999 }, ai_synthesis: { headline: "fabricated" } }),
    deps,
  );
  const args = sentToRpc as any;
  assertEquals(Object.keys(args).sort(), ["p_area", "p_mission"]);
});

// Integration-shaped tests for area-geological-analogues with injected
// dependencies (no live Supabase stack): request validation, limit
// clamping, the RPC call shape, error mapping, and spoofing-resistance.
// Phase 13 (Geological Intelligence Transformation).
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleAreaGeologicalAnalogues, type AreaAnaloguesDeps } from "./handler.ts";
import type { Actor } from "../_shared/enterprise/auth.ts";
import { UnauthorizedError } from "../_shared/enterprise/errors.ts";

const OWNER: Actor = { userId: "owner-1", email: "owner@example.com", contributorId: "c1", role: "admin" };

function req(body?: Record<string, unknown>, method = "POST"): Request {
  return new Request("https://x/area-geological-analogues", { method, body: body ? JSON.stringify(body) : undefined });
}

const FAKE_RESULT = {
  target_h3: "8752de409ffffff", commodities: ["Iron"], deposit_style_ontology_populated: false,
  analogues: [{ name: "Bur Acaba Magnetic Anomaly", commodity_key: "Iron", deposit_type: null, shares_deposit_type: false }],
  note: "deposit-style ontology not yet populated in this dataset — analogues are matched by commodity (and deposit_type where recorded) only",
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

function baseDeps(overrides: Partial<AreaAnaloguesDeps> = {}): AreaAnaloguesDeps {
  return {
    resolveActor: async () => OWNER,
    userClient: fakeUserClient(() => {}),
    ...overrides,
  };
}

Deno.test("OPTIONS returns CORS preflight ok", async () => {
  const r = await handleAreaGeologicalAnalogues(req(undefined, "OPTIONS"), baseDeps());
  assertEquals(r.status, 200);
});

Deno.test("missing missionId/areaId → 400 validation errors", async () => {
  const r1 = await handleAreaGeologicalAnalogues(req({ areaId: "a1" }), baseDeps());
  assertEquals(r1.status, 400);
  const r2 = await handleAreaGeologicalAnalogues(req({ missionId: "m1" }), baseDeps());
  assertEquals(r2.status, 400);
});

Deno.test("missionId/areaId reach the RPC unchanged, default limit applied", async () => {
  let sentToRpc: Record<string, unknown> | null = null;
  const deps = baseDeps({ userClient: fakeUserClient((fn, args) => { assertEquals(fn, "area_geological_analogues"); sentToRpc = args; }) });
  const r = await handleAreaGeologicalAnalogues(req({ missionId: "mission-42", areaId: "area-7" }), deps);
  assertEquals(r.status, 200);
  const args = sentToRpc as any;
  assertEquals(args.p_mission, "mission-42");
  assertEquals(args.p_area, "area-7");
  assertEquals(args.p_limit, 5);
});

Deno.test("a custom limit is honored, clamped to [1,20]", async () => {
  let sentToRpc: Record<string, unknown> | null = null;
  const deps = baseDeps({ userClient: fakeUserClient((_fn, args) => { sentToRpc = args; }) });
  await handleAreaGeologicalAnalogues(req({ missionId: "m1", areaId: "a1", limit: 3 }), deps);
  assertEquals((sentToRpc as any).p_limit, 3);

  await handleAreaGeologicalAnalogues(req({ missionId: "m1", areaId: "a1", limit: 999 }), deps);
  assertEquals((sentToRpc as any).p_limit, 20);

  await handleAreaGeologicalAnalogues(req({ missionId: "m1", areaId: "a1", limit: -5 }), deps);
  assertEquals((sentToRpc as any).p_limit, 1);
});

Deno.test("the RPC's result is returned verbatim, including the ontology-gap note", async () => {
  const r = await handleAreaGeologicalAnalogues(req({ missionId: "m1", areaId: "a1" }), baseDeps());
  const b = await r.json();
  assertEquals(b, FAKE_RESULT);
  assertEquals(b.deposit_style_ontology_populated, false);
  assert(/not yet populated/i.test(b.note));
});

Deno.test("missing/invalid JWT → 401 via errorResponse", async () => {
  const deps = baseDeps({ resolveActor: async () => { throw new UnauthorizedError("invalid or expired token"); } });
  const r = await handleAreaGeologicalAnalogues(req({ missionId: "m1", areaId: "a1" }), deps);
  assertEquals(r.status, 401);
});

Deno.test("a non-member is refused by the RPC's own authorization check, surfaced as an error", async () => {
  const deps = baseDeps({
    userClient: (_req: Request) => ({
      schema: (_s: string) => ({
        rpc: (_fn: string, _args: Record<string, unknown>) =>
          Promise.resolve({ data: null, error: { message: "forbidden: only a member of this mission can view geological analogues for its areas" } }),
      }),
    }) as any,
  });
  const r = await handleAreaGeologicalAnalogues(req({ missionId: "m1", areaId: "a1" }), deps);
  assertEquals(r.status, 400);
  const b = await r.json();
  assert(/forbidden/i.test(b.error));
});

Deno.test("[security] client-supplied analogues/commodities in the body are never read or forwarded", async () => {
  let sentToRpc: Record<string, unknown> | null = null;
  const deps = baseDeps({ userClient: fakeUserClient((_fn, args) => { sentToRpc = args; }) });
  await handleAreaGeologicalAnalogues(
    req({ missionId: "m1", areaId: "a1", analogues: [{ fabricated: true }], commodities: ["Gold"] }),
    deps,
  );
  const args = sentToRpc as any;
  assertEquals(Object.keys(args).sort(), ["p_area", "p_limit", "p_mission"]);
});

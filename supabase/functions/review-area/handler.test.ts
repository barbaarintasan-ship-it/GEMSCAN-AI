// Integration-shaped tests for review-area with injected dependencies (no
// live Supabase stack): request validation, the RPC call shape, error
// mapping, and — since a malicious client could try to claim review
// authority it doesn't have — explicit spoofing-resistance tests showing
// reviewer identity/role/mission scoping are never taken from the request
// body, only from what the RPC itself derives server-side.
// Phase 11 (Geological Intelligence Transformation).
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  handleReviewArea, REVIEW_DECISIONS, type ReviewAreaDeps,
} from "./handler.ts";
import type { Actor } from "../_shared/enterprise/auth.ts";
import { UnauthorizedError } from "../_shared/enterprise/errors.ts";

const OWNER: Actor = { userId: "owner-1", email: "owner@example.com", contributorId: "c1", role: "admin" };

function req(body?: Record<string, unknown>, method = "POST"): Request {
  return new Request("https://x/review-area", { method, body: body ? JSON.stringify(body) : undefined });
}

/** Captures exactly what the handler sends to the RPC, without a live DB. */
function fakeUserClient(onRpc: (fn: string, args: Record<string, unknown>) => void) {
  return (_req: Request) => ({
    schema: (_s: string) => ({
      rpc: (fn: string, args: Record<string, unknown>) => {
        onRpc(fn, args);
        return Promise.resolve({
          data: {
            area_id: args.p_area, review_status: args.p_decision,
            reviewed_by: "server-derived-uid", reviewed_at: "2026-01-01T00:00:00Z",
          },
          error: null,
        });
      },
    }),
  }) as any;
}

function baseDeps(overrides: Partial<ReviewAreaDeps> = {}): ReviewAreaDeps {
  return {
    resolveActor: async () => OWNER,
    userClient: fakeUserClient(() => {}),
    ...overrides,
  };
}

Deno.test("OPTIONS returns CORS preflight ok", async () => {
  const r = await handleReviewArea(req(undefined, "OPTIONS"), baseDeps());
  assertEquals(r.status, 200);
});

Deno.test("missing missionId/areaId/decision → 400 validation errors", async () => {
  const r1 = await handleReviewArea(req({ areaId: "a1", decision: "accepted" }), baseDeps());
  assertEquals(r1.status, 400);
  const r2 = await handleReviewArea(req({ missionId: "m1", decision: "accepted" }), baseDeps());
  assertEquals(r2.status, 400);
  const r3 = await handleReviewArea(req({ missionId: "m1", areaId: "a1" }), baseDeps());
  assertEquals(r3.status, 400);
});

Deno.test("an invalid decision value is refused, RPC never called", async () => {
  let rpcCalled = false;
  const deps = baseDeps({ userClient: fakeUserClient(() => { rpcCalled = true; }) });
  const r = await handleReviewArea(req({ missionId: "m1", areaId: "a1", decision: "definitely gold" }), deps);
  assertEquals(r.status, 400);
  assertEquals(rpcCalled, false);
});

for (const decision of REVIEW_DECISIONS) {
  Deno.test(`[valid transition] decision=${decision} reaches the RPC and is echoed in the response`, async () => {
    let sentToRpc: Record<string, unknown> | null = null;
    const deps = baseDeps({ userClient: fakeUserClient((fn, args) => { assertEquals(fn, "review_area"); sentToRpc = args; }) });
    const r = await handleReviewArea(req({ missionId: "m1", areaId: "a1", decision }), deps);
    assertEquals(r.status, 200);
    const b = await r.json();
    assertEquals(b.reviewStatus, decision);
    assertEquals((sentToRpc as any).p_decision, decision);
  });
}

Deno.test("missionId/areaId reach the RPC unchanged", async () => {
  let sentToRpc: Record<string, unknown> | null = null;
  const deps = baseDeps({ userClient: fakeUserClient((_fn, args) => { sentToRpc = args; }) });
  const r = await handleReviewArea(req({ missionId: "mission-42", areaId: "area-7", decision: "accepted" }), deps);
  assertEquals(r.status, 200);
  const args = sentToRpc as any;
  assertEquals(args.p_mission, "mission-42");
  assertEquals(args.p_area, "area-7");
});

Deno.test("optional notes pass through; omitted notes send null, never an empty string placeholder", async () => {
  let sentToRpc: Record<string, unknown> | null = null;
  const deps = baseDeps({ userClient: fakeUserClient((_fn, args) => { sentToRpc = args; }) });
  const r1 = await handleReviewArea(
    req({ missionId: "m1", areaId: "a1", decision: "needs_more_data", notes: "Structural relationship plausible, no field verification yet." }),
    deps,
  );
  assertEquals(r1.status, 200);
  assertEquals((sentToRpc as any).p_notes, "Structural relationship plausible, no field verification yet.");

  const r2 = await handleReviewArea(req({ missionId: "m1", areaId: "a1", decision: "accepted" }), deps);
  assertEquals(r2.status, 200);
  assertEquals((sentToRpc as any).p_notes, null);
});

Deno.test("missing/invalid JWT → 401 via errorResponse", async () => {
  const deps = baseDeps({ resolveActor: async () => { throw new UnauthorizedError("invalid or expired token"); } });
  const r = await handleReviewArea(req({ missionId: "m1", areaId: "a1", decision: "accepted" }), deps);
  assertEquals(r.status, 401);
});

Deno.test("a non-manager is refused by the RPC's own authorization check, surfaced as an error", async () => {
  const deps = baseDeps({
    userClient: (_req: Request) => ({
      schema: (_s: string) => ({
        rpc: (_fn: string, _args: Record<string, unknown>) =>
          Promise.resolve({ data: null, error: { message: "forbidden: only the mission owner or an org owner/admin can review this mission's areas" } }),
      }),
    }) as any,
  });
  const r = await handleReviewArea(req({ missionId: "m1", areaId: "a1", decision: "accepted" }), deps);
  assertEquals(r.status, 400);
  const b = await r.json();
  assert(/forbidden/i.test(b.error));
});

Deno.test("an area that doesn't belong to the given mission is refused by the RPC, surfaced as an error", async () => {
  const deps = baseDeps({
    userClient: (_req: Request) => ({
      schema: (_s: string) => ({
        rpc: (_fn: string, _args: Record<string, unknown>) =>
          Promise.resolve({ data: null, error: { message: "validation: area a1 does not belong to mission m1" } }),
      }),
    }) as any,
  });
  const r = await handleReviewArea(req({ missionId: "m1", areaId: "a1", decision: "accepted" }), deps);
  assertEquals(r.status, 400);
});

// ── Security: a hostile client cannot spoof reviewer identity/role/scope ────
// The handler has NO code path that reads a client-supplied user id, role,
// org id, or mission id and forwards it as if it were server-derived — the
// RPC call only ever sends p_mission/p_area/p_decision/p_notes (validated
// request-body fields) plus the caller's own forwarded JWT (deps.userClient),
// from which the RPC derives auth.uid() itself. These tests prove a hostile
// body cannot inject an alternate identity into what reaches the RPC.

Deno.test("[security] a client-supplied reviewedBy/reviewerId/userId is never read or forwarded", async () => {
  let sentToRpc: Record<string, unknown> | null = null;
  const deps = baseDeps({ userClient: fakeUserClient((_fn, args) => { sentToRpc = args; }) });
  const r = await handleReviewArea(
    req({
      missionId: "m1", areaId: "a1", decision: "accepted",
      reviewedBy: "attacker-uid", reviewerId: "attacker-uid", userId: "attacker-uid", reviewed_by: "attacker-uid",
    }),
    deps,
  );
  assertEquals(r.status, 200);
  const args = sentToRpc as any;
  assertEquals(Object.keys(args).sort(), ["p_area", "p_decision", "p_mission", "p_notes"]);
});

Deno.test("[security] a client-supplied reviewerRole/role is never read or forwarded", async () => {
  let sentToRpc: Record<string, unknown> | null = null;
  const deps = baseDeps({ userClient: fakeUserClient((_fn, args) => { sentToRpc = args; }) });
  await handleReviewArea(
    req({ missionId: "m1", areaId: "a1", decision: "accepted", reviewerRole: "senior_geologist", role: "chief_geologist" }),
    deps,
  );
  const args = sentToRpc as any;
  assert(!("p_reviewer_role" in args) && !("reviewerRole" in args) && !("role" in args));
});

Deno.test("[security] a client-supplied organizationId/orgId cannot redirect the review to another organization's mission", async () => {
  let sentToRpc: Record<string, unknown> | null = null;
  const deps = baseDeps({ userClient: fakeUserClient((_fn, args) => { sentToRpc = args; }) });
  await handleReviewArea(
    req({ missionId: "my-mission", areaId: "a1", decision: "accepted", organizationId: "other-org", orgId: "other-org" }),
    deps,
  );
  const args = sentToRpc as any;
  assertEquals(args.p_mission, "my-mission"); // only the declared missionId is ever sent — no org override field exists
  assert(!("organizationId" in args) && !("orgId" in args));
});

Deno.test("[security] the reviewed-at timestamp in the response comes from the RPC result, never echoed from the request", async () => {
  const deps = baseDeps({
    userClient: fakeUserClient((_fn, args) => {
      assert(!("reviewedAt" in args) && !("reviewed_at" in args) && !("timestamp" in args));
    }),
  });
  const r = await handleReviewArea(
    req({ missionId: "m1", areaId: "a1", decision: "accepted", reviewedAt: "1999-01-01T00:00:00Z" }),
    deps,
  );
  const b = await r.json();
  assertEquals(b.reviewedAt, "2026-01-01T00:00:00Z"); // the RPC's own server-generated value, not the spoofed one
});

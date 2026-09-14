// Integration-shaped tests for create-followup-mission with injected
// dependencies (no live Supabase stack): JWT flow, request validation, "no
// scored cells yet" is refused rather than defaulted, the RPC call shape
// (best cell + provenance passed through unchanged), valid envelope
// geometry, and error mapping. Solo→Team shared-targeting Phase 9.
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  handleCreateFollowupMission, FOLLOWUP_ENVELOPE_RINGS, type CreateFollowupMissionDeps, type BestCell,
} from "./handler.ts";
import type { Actor } from "../_shared/enterprise/auth.ts";
import { UnauthorizedError } from "../_shared/enterprise/errors.ts";
import { cellBoundaryRing, kRing } from "../_shared/geocontext/h3.ts";

const OWNER: Actor = { userId: "owner-1", email: "owner@example.com", contributorId: "c1", role: "admin" };
const VALID_H3 = "8752de409ffffff"; // a real resolution-7 H3 cell — the envelope test calls real h3-js

function req(body?: Record<string, unknown>, method = "POST"): Request {
  return new Request("https://x/create-followup-mission", {
    method,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function fakeUserClient(onRpc: (fn: string, args: Record<string, unknown>) => void) {
  return (_req: Request) => ({
    schema: (_s: string) => ({
      rpc: (fn: string, args: Record<string, unknown>) => {
        onRpc(fn, args);
        return Promise.resolve({ data: { mission_id: "new-mission-id", area_id: "new-area-id" }, error: null });
      },
    }),
  }) as any;
}

function baseDeps(overrides: Partial<CreateFollowupMissionDeps> = {}): CreateFollowupMissionDeps {
  return {
    resolveActor: async () => OWNER,
    userClient: fakeUserClient(() => {}),
    bestCell: async (): Promise<BestCell | null> => ({ targetH3: VALID_H3, score: 0.68 }),
    ...overrides,
  };
}

Deno.test("OPTIONS returns CORS preflight ok", async () => {
  const r = await handleCreateFollowupMission(req(undefined, "OPTIONS"), baseDeps());
  assertEquals(r.status, 200);
});

Deno.test("missing sourceMissionId/name → 400 validation errors", async () => {
  const r1 = await handleCreateFollowupMission(req({ name: "Followup" }), baseDeps());
  assertEquals(r1.status, 400);
  const r2 = await handleCreateFollowupMission(req({ sourceMissionId: "m1" }), baseDeps());
  assertEquals(r2.status, 400);
});

Deno.test("[architecture] a source mission with no scored cells is refused, never defaulted", async () => {
  let rpcCalled = false;
  const deps = baseDeps({
    bestCell: async () => null,
    userClient: fakeUserClient(() => { rpcCalled = true; }),
  });
  const r = await handleCreateFollowupMission(req({ sourceMissionId: "m1", name: "Followup" }), deps);
  assertEquals(r.status, 400);
  assertEquals(rpcCalled, false);
});

Deno.test("the best cell and its score reach the RPC unchanged, alongside source provenance", async () => {
  let sentToRpc: Record<string, unknown> | null = null;
  const deps = baseDeps({
    bestCell: async () => ({ targetH3: VALID_H3, score: 0.81 }),
    userClient: fakeUserClient((fn, args) => { assertEquals(fn, "create_followup_mission"); sentToRpc = args; }),
  });
  const r = await handleCreateFollowupMission(
    req({ sourceMissionId: "mission-source-1", name: "Followup Sweep", commodity: "gold" }),
    deps,
  );
  assertEquals(r.status, 201);
  const args = sentToRpc as any;
  assertEquals(args.p_source_mission, "mission-source-1");
  assertEquals(args.p_target_h3, VALID_H3);
  assertEquals(args.p_target_score, 0.81);
  assertEquals(args.p_commodity, "gold");
  assertEquals(args.p_envelope_rings, FOLLOWUP_ENVELOPE_RINGS);
  assert(typeof args.p_boundary_geojson === "string" && args.p_boundary_geojson.includes("MultiPolygon"));

  const b = await r.json();
  assertEquals(b.missionId, "new-mission-id");
  assertEquals(b.areaId, "new-area-id");
  assertEquals(b.sourceTargetH3, VALID_H3);
  assertEquals(b.sourceScore, 0.81);
});

Deno.test("the envelope is valid MultiPolygon geometry — one closed ring per k-ring cell", () => {
  const cells = kRing(VALID_H3, FOLLOWUP_ENVELOPE_RINGS);
  assertEquals(cells.length, 7); // centre + 6 neighbours at ring 1
  for (const c of cells) {
    const ring = cellBoundaryRing(c);
    assert(ring.length >= 4, "a hex boundary ring needs at least 4 points to be closed");
    assertEquals(ring[0][0], ring[ring.length - 1][0]);
    assertEquals(ring[0][1], ring[ring.length - 1][1]);
  }
});

Deno.test("missing/invalid JWT → 401 via errorResponse", async () => {
  const deps = baseDeps({ resolveActor: async () => { throw new UnauthorizedError("invalid or expired token"); } });
  const r = await handleCreateFollowupMission(req({ sourceMissionId: "m1", name: "x" }), deps);
  assertEquals(r.status, 401);
});

Deno.test("a non-manager of the source mission is refused by the RPC's own authorization check", async () => {
  const deps = baseDeps({
    userClient: () => ({
      schema: () => ({
        rpc: () => Promise.resolve({
          data: null,
          error: { message: "forbidden: only the source mission's owner or an org owner/admin can create a follow-up mission" },
        }),
      }),
    }) as any,
  });
  const r = await handleCreateFollowupMission(req({ sourceMissionId: "m1", name: "x" }), deps);
  assertEquals(r.status, 400); // same RPC-error mapping accept-recommended-area/score-mission-cells use
  const b = await r.json();
  assert(/forbidden/i.test(b.error));
});

Deno.test("a spoofed/stale (target_h3, score) pair is refused by the RPC's own re-verification", async () => {
  const deps = baseDeps({
    userClient: () => ({
      schema: () => ({
        rpc: () => Promise.resolve({
          data: null,
          error: { message: "validation: target_h3/target_score do not match a scored cell of the source mission" },
        }),
      }),
    }) as any,
  });
  const r = await handleCreateFollowupMission(req({ sourceMissionId: "m1", name: "x" }), deps);
  assertEquals(r.status, 400);
});

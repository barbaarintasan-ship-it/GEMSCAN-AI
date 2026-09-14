// Integration-shaped tests for create-manual-area with injected dependencies
// (no live Supabase stack): JWT flow, request validation, envelope geometry,
// RPC call shape, and error mapping.
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleCreateManualArea, MANUAL_AREA_ENVELOPE_RINGS, type CreateManualAreaDeps } from "./handler.ts";
import type { Actor } from "../_shared/enterprise/auth.ts";
import { UnauthorizedError } from "../_shared/enterprise/errors.ts";
import { cellFor, kRing } from "../_shared/geocontext/h3.ts";

const OWNER: Actor = { userId: "owner-1", email: "owner@example.com", contributorId: "c1", role: "admin" };

function req(body?: Record<string, unknown>, method = "POST"): Request {
  return new Request("https://x/create-manual-area", { method, body: body ? JSON.stringify(body) : undefined });
}

function fakeUserClient(onRpc: (fn: string, args: Record<string, unknown>) => void) {
  return (_req: Request) => ({
    schema: (_s: string) => ({
      rpc: (fn: string, args: Record<string, unknown>) => {
        onRpc(fn, args);
        return Promise.resolve({ data: "new-area-id", error: null });
      },
    }),
  }) as any;
}

function baseDeps(overrides: Partial<CreateManualAreaDeps> = {}): CreateManualAreaDeps {
  return {
    resolveActor: async () => OWNER,
    userClient: fakeUserClient(() => {}),
    ...overrides,
  };
}

Deno.test("OPTIONS returns CORS preflight ok", async () => {
  const r = await handleCreateManualArea(req(undefined, "OPTIONS"), baseDeps());
  assertEquals(r.status, 200);
});

Deno.test("missing missionId/name/lat/lng → 400 validation errors", async () => {
  const r1 = await handleCreateManualArea(req({ name: "x", lat: 9.5, lng: 44.5 }), baseDeps());
  assertEquals(r1.status, 400);
  const r2 = await handleCreateManualArea(req({ missionId: "m1", lat: 9.5, lng: 44.5 }), baseDeps());
  assertEquals(r2.status, 400);
  const r3 = await handleCreateManualArea(req({ missionId: "m1", name: "x", lat: 999, lng: 44.5 }), baseDeps());
  assertEquals(r3.status, 400);
  const r4 = await handleCreateManualArea(req({ missionId: "m1", name: "x", lng: 44.5 }), baseDeps());
  assertEquals(r4.status, 400);
});

Deno.test("rings out of [1,5] range is rejected", async () => {
  const r1 = await handleCreateManualArea(req({ missionId: "m1", name: "x", lat: 9.5, lng: 44.5, rings: 0 }), baseDeps());
  assertEquals(r1.status, 400);
  const r2 = await handleCreateManualArea(req({ missionId: "m1", name: "x", lat: 9.5, lng: 44.5, rings: 6 }), baseDeps());
  assertEquals(r2.status, 400);
  const r3 = await handleCreateManualArea(req({ missionId: "m1", name: "x", lat: 9.5, lng: 44.5, rings: 1.5 }), baseDeps());
  assertEquals(r3.status, 400);
});

Deno.test("no evidence/scoring is required — a bare center point creates the area", async () => {
  let sentToRpc: Record<string, unknown> | null = null;
  const deps = baseDeps({
    userClient: fakeUserClient((fn, args) => { assertEquals(fn, "create_manual_mission_area"); sentToRpc = args; }),
  });
  const r = await handleCreateManualArea(req({ missionId: "mission-42", name: "Fault Zone A", lat: 9.5, lng: 44.5 }), deps);
  assertEquals(r.status, 201);
  const args = sentToRpc as any;
  assertEquals(args.p_mission, "mission-42");
  assertEquals(args.p_name, "Fault Zone A");
  assertEquals(args.p_center_lat, 9.5);
  assertEquals(args.p_center_lng, 44.5);
  assertEquals(args.p_envelope_rings, MANUAL_AREA_ENVELOPE_RINGS);
  assert(typeof args.p_boundary_geojson === "string" && args.p_boundary_geojson.includes("MultiPolygon"));

  const b = await r.json();
  assertEquals(b.areaId, "new-area-id");
  assertEquals(b.envelopeRings, MANUAL_AREA_ENVELOPE_RINGS);
});

Deno.test("a custom rings value is honored and reflected in cellCount", async () => {
  let sentToRpc: Record<string, unknown> | null = null;
  const deps = baseDeps({ userClient: fakeUserClient((_fn, args) => { sentToRpc = args; }) });
  const r = await handleCreateManualArea(req({ missionId: "m1", name: "x", lat: 9.5, lng: 44.5, rings: 1 }), deps);
  const b = await r.json();
  assertEquals((sentToRpc as any).p_envelope_rings, 1);
  const expectedCells = kRing(cellFor(9.5, 44.5), 1).length;
  assertEquals(b.cellCount, expectedCells);
});

Deno.test("missing/invalid JWT → 401 via errorResponse", async () => {
  const deps = baseDeps({ resolveActor: async () => { throw new UnauthorizedError("invalid or expired token"); } });
  const r = await handleCreateManualArea(req({ missionId: "m1", name: "x", lat: 9.5, lng: 44.5 }), deps);
  assertEquals(r.status, 401);
});

Deno.test("a non-manager is refused by the RPC's own authorization check", async () => {
  const deps = baseDeps({
    userClient: () => ({
      schema: () => ({
        rpc: () => Promise.resolve({
          data: null,
          error: { message: "forbidden: only the mission owner or an org owner/admin can create an area for this mission" },
        }),
      }),
    }) as any,
  });
  const r = await handleCreateManualArea(req({ missionId: "m1", name: "x", lat: 9.5, lng: 44.5 }), deps);
  assertEquals(r.status, 400); // same RPC-error mapping accept-recommended-area/create-followup-mission use
  const b = await r.json();
  assert(/forbidden/i.test(b.error));
});

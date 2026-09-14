// Integration-shaped tests for accept-recommended-area with injected
// dependencies (no live Supabase stack): verifies the JWT flow, request
// validation, server-authoritative re-scoring (a client-sent score is never
// trusted or stored), the RPC call shape (mission/provenance passed through
// correctly), valid envelope geometry, and error mapping.
// Solo→Team shared-targeting Phase 2.
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  handleAcceptRecommendedArea, EXPLORATION_ENVELOPE_RINGS, type AcceptRecommendedAreaDeps,
} from "./handler.ts";
import type { Actor } from "../_shared/enterprise/auth.ts";
import { UnauthorizedError } from "../_shared/enterprise/errors.ts";
import type { ExplorationTarget } from "../../../shared/geo-core/gie/targetingEngine.ts";
import { cellBoundaryRing, kRing } from "../_shared/geocontext/h3.ts";

const OWNER: Actor = { userId: "owner-1", email: "owner@example.com", contributorId: "c1", role: "admin" };
const VALID_H3 = "8752de409ffffff"; // a real resolution-7 H3 cell (latLngToCell(9.5, 44.5, 7)) — the envelope/geometry test calls real h3-js, so this must be a genuinely valid cell, not just regex-shaped

function req(body?: Record<string, unknown>, method = "POST"): Request {
  return new Request("https://x/accept-recommended-area", {
    method,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function fakeTarget(score: number): ExplorationTarget {
  return {
    cell: VALID_H3,
    centre: { lat: 9.5, lng: 44.5 },
    bearingDeg: 0, compass: "N", distanceM: 0,
    score, reportScore: score, band: score > 0.5 ? "High" : "Low",
    reasons: [{ kind: "occurrence", commodity: "Gold", distanceM: 500 }],
    commodities: ["Gold"], coverage: { roles: [], present: 0, total: 13, unavailable: [] },
    scoredForCommodity: null, evidence: [],
  };
}

/** Captures exactly what the handler sends to the RPC, without a live DB. */
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

function baseDeps(overrides: Partial<AcceptRecommendedAreaDeps> = {}): AcceptRecommendedAreaDeps {
  return {
    resolveActor: async () => OWNER,
    userClient: fakeUserClient(() => {}),
    scoreTarget: async () => fakeTarget(0.62),
    ...overrides,
  };
}

Deno.test("OPTIONS returns CORS preflight ok", async () => {
  const r = await handleAcceptRecommendedArea(req(undefined, "OPTIONS"), baseDeps());
  assertEquals(r.status, 200);
});

Deno.test("missing missionId/name/targetH3 → 400 validation errors", async () => {
  const r1 = await handleAcceptRecommendedArea(req({ name: "x", targetH3: VALID_H3 }), baseDeps());
  assertEquals(r1.status, 400);
  const r2 = await handleAcceptRecommendedArea(req({ missionId: "m1", targetH3: VALID_H3 }), baseDeps());
  assertEquals(r2.status, 400);
  const r3 = await handleAcceptRecommendedArea(req({ missionId: "m1", name: "x", targetH3: "not-a-cell" }), baseDeps());
  assertEquals(r3.status, 400);
});

Deno.test("[C] response score comes from server re-scoring, not the request body", async () => {
  const deps = baseDeps({ scoreTarget: async () => fakeTarget(0.77) });
  const r = await handleAcceptRecommendedArea(req({ missionId: "m1", name: "Area A", targetH3: VALID_H3 }), deps);
  assertEquals(r.status, 201);
  const b = await r.json();
  assertEquals(b.sourceTargetScore, 0.77);
});

Deno.test("[D] a client-supplied score is never read, stored, or trusted", async () => {
  let sentToRpc: Record<string, unknown> | null = null;
  const deps = baseDeps({
    scoreTarget: async () => fakeTarget(0.42), // the ONLY score that should ever surface
    userClient: fakeUserClient((_fn, args) => { sentToRpc = args; }),
  });
  // A hostile client claims a near-certain score in the body.
  const r = await handleAcceptRecommendedArea(
    req({ missionId: "m1", name: "Area A", targetH3: VALID_H3, score: 0.999, sourceTargetScore: 0.999 }),
    deps,
  );
  const b = await r.json();
  assertEquals(b.sourceTargetScore, 0.42);
  assertEquals((sentToRpc as any)?.p_target_score, 0.42);
});

Deno.test("[E] no area is created until this explicit accept call — a stale/scoreless cell is refused, not defaulted", async () => {
  let rpcCalled = false;
  const deps = baseDeps({
    scoreTarget: async () => null, // Invariant 2: nothing to say about this cell any more
    userClient: fakeUserClient(() => { rpcCalled = true; }),
  });
  const r = await handleAcceptRecommendedArea(req({ missionId: "m1", name: "Area A", targetH3: VALID_H3 }), deps);
  assertEquals(r.status, 400);
  assertEquals(rpcCalled, false);
});

Deno.test("[F] the envelope is valid MultiPolygon geometry — one closed ring per k-ring cell", () => {
  const cells = kRing(VALID_H3, EXPLORATION_ENVELOPE_RINGS);
  assertEquals(cells.length, 7); // centre + 6 neighbours at ring 1
  for (const c of cells) {
    const ring = cellBoundaryRing(c);
    assert(ring.length >= 4, "a hex boundary ring needs at least 4 points to be closed");
    assertEquals(ring[0][0], ring[ring.length - 1][0]); // closed: first === last
    assertEquals(ring[0][1], ring[ring.length - 1][1]);
  }
});

Deno.test("[G,H] mission id and full source provenance reach the RPC unchanged", async () => {
  let sentToRpc: Record<string, unknown> | null = null;
  const deps = baseDeps({
    scoreTarget: async () => fakeTarget(0.55),
    userClient: fakeUserClient((fn, args) => { assertEquals(fn, "create_mission_area_from_target"); sentToRpc = args; }),
  });
  const r = await handleAcceptRecommendedArea(
    req({ missionId: "mission-42", name: "Gold Target Area", targetH3: VALID_H3, commodity: "gold" }),
    deps,
  );
  assertEquals(r.status, 201);
  const args = sentToRpc as any;
  assertEquals(args.p_mission, "mission-42");
  assertEquals(args.p_target_h3, VALID_H3);
  assertEquals(args.p_target_score, 0.55);
  assertEquals(args.p_commodity, "gold");
  assertEquals(args.p_envelope_rings, EXPLORATION_ENVELOPE_RINGS);
  assert(typeof args.p_boundary_geojson === "string" && args.p_boundary_geojson.includes("MultiPolygon"));
});

Deno.test("[K] evidence caveat is present in the response", async () => {
  const r = await handleAcceptRecommendedArea(req({ missionId: "m1", name: "Area A", targetH3: VALID_H3 }), baseDeps());
  const b = await r.json();
  assert(typeof b.evidenceCaveat === "string" && b.evidenceCaveat.length > 0);
  assert(/structural/i.test(b.evidenceCaveat) && /lithology/i.test(b.evidenceCaveat));
});

Deno.test("missing/invalid JWT → 401 via errorResponse", async () => {
  const deps = baseDeps({ resolveActor: async () => { throw new UnauthorizedError("invalid or expired token"); } });
  const r = await handleAcceptRecommendedArea(req({ missionId: "m1", name: "x", targetH3: VALID_H3 }), deps);
  assertEquals(r.status, 401);
});

Deno.test("[B] a non-manager is refused by the RPC's own authorization check, surfaced as an error", async () => {
  const deps = baseDeps({
    userClient: fakeUserClient(() => {}),
    scoreTarget: async () => fakeTarget(0.6),
  });
  deps.userClient = (_req: Request) => ({
    schema: (_s: string) => ({
      rpc: (_fn: string, _args: Record<string, unknown>) =>
        Promise.resolve({ data: null, error: { message: "forbidden: only the mission owner or an org owner/admin can create an area for this mission" } }),
    }),
  }) as any;
  const r = await handleAcceptRecommendedArea(req({ missionId: "m1", name: "x", targetH3: VALID_H3 }), deps);
  assertEquals(r.status, 400); // same mapping generate-mission-cells uses for RPC-raised errors
  const b = await r.json();
  assert(/forbidden/i.test(b.error));
});

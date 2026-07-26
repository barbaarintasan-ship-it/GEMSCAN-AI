// Integration-shaped tests for the enterprise-context handler with injected
// dependencies (no live Supabase stack): verifies the JWT→identity→entitlement
// flow, the owner fast-path, the disabled-caller status response, and error mapping.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type ContextDeps, handleContext } from "./handler.ts";
import type { Actor } from "../_shared/enterprise/auth.ts";
import { UnauthorizedError } from "../_shared/enterprise/errors.ts";

const OWNER: Actor = { userId: "owner-1", email: "awmusse.musse@gmail.com", contributorId: "c1", role: "admin" };
const NORMAL: Actor = { userId: "user-2", email: "someone@else.com", contributorId: null, role: null };

function req(method = "GET"): Request {
  return new Request("https://x/enterprise-context", { method });
}

Deno.test("OPTIONS returns CORS preflight ok", async () => {
  const r = await handleContext(req("OPTIONS"), { resolveActor: async () => OWNER, isEnterpriseEnabled: async () => true });
  assertEquals(r.status, 200);
});

Deno.test("owner is enterprise-enabled and flagged isOwner", async () => {
  const deps: ContextDeps = { resolveActor: async () => OWNER, isEnterpriseEnabled: async () => true };
  const r = await handleContext(req(), deps);
  assertEquals(r.status, 200);
  const b = await r.json();
  assertEquals(b.enterpriseEnabled, true);
  assertEquals(b.isOwner, true);
  assertEquals(b.role, "admin");
});

Deno.test("non-enterprise caller gets a clear 200 status (not a 403)", async () => {
  const deps: ContextDeps = { resolveActor: async () => NORMAL, isEnterpriseEnabled: async () => false };
  const r = await handleContext(req(), deps);
  assertEquals(r.status, 200);
  const b = await r.json();
  assertEquals(b.enterpriseEnabled, false);
  assertEquals(b.userId, "user-2");
  assertEquals(typeof b.reason, "string");
});

Deno.test("missing/invalid JWT → 401 via errorResponse", async () => {
  const deps: ContextDeps = {
    resolveActor: async () => { throw new UnauthorizedError("invalid or expired token"); },
    isEnterpriseEnabled: async () => true,
  };
  const r = await handleContext(req(), deps);
  assertEquals(r.status, 401);
  const b = await r.json();
  assertEquals(b.code, "unauthorized");
});

Deno.test("unexpected error is mapped to an opaque 500", async () => {
  const deps: ContextDeps = {
    resolveActor: async () => { throw new Error("db exploded with secret detail"); },
    isEnterpriseEnabled: async () => true,
  };
  const r = await handleContext(req(), deps);
  assertEquals(r.status, 500);
  const b = await r.json();
  assertEquals(b.error, "internal error");
  assertEquals(String(b.error).includes("secret"), false);
});

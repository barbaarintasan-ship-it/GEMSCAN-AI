// Unit tests for the pure authorization logic (no DB): owner gate, role checks,
// and error mapping. The DB-backed paths (resolveActor, context, requireEnterprise)
// are covered by the integration reference function in Sprint 4.1.b.
import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { hasRole, isAdmin, isOwner, requireAdmin, requireRole } from "./authz.ts";
import { EnterpriseError, errorResponse, ForbiddenError, UnauthorizedError } from "./errors.ts";
import type { Actor } from "./auth.ts";

function actor(over: Partial<Actor> = {}): Actor {
  return { userId: "u1", email: null, contributorId: null, role: null, ...over };
}

Deno.test("isOwner matches the owner allowlist, case-insensitive", () => {
  assertEquals(isOwner(actor({ email: "awmusse.musse@gmail.com" })), true);
  assertEquals(isOwner(actor({ email: "AWMUSSE.MUSSE@GMAIL.COM" })), true);
  assertEquals(isOwner(actor({ email: "someone@else.com" })), false);
  assertEquals(isOwner(actor({ email: null })), false);
});

Deno.test("hasRole / requireRole gate on contributor role", () => {
  assertEquals(hasRole(actor({ role: "team_leader" }), "team_leader", "admin"), true);
  assertEquals(hasRole(actor({ role: "normal" }), "admin"), false);
  requireRole(actor({ role: "admin" }), "admin"); // no throw
  assertThrows(() => requireRole(actor({ role: "normal" }), "admin"), ForbiddenError);
});

Deno.test("owner overrides role and admin checks even with role=null", () => {
  const owner = actor({ email: "awmusse.musse@gmail.com", role: null });
  requireRole(owner, "admin"); // no throw
  assertEquals(isAdmin(owner), true);
  requireAdmin(owner); // no throw
});

Deno.test("isAdmin / requireAdmin", () => {
  assertEquals(isAdmin(actor({ role: "admin" })), true);
  assertEquals(isAdmin(actor({ role: "normal" })), false);
  assertThrows(() => requireAdmin(actor({ role: "normal" })), ForbiddenError);
});

Deno.test("errorResponse maps EnterpriseError to its status + code", async () => {
  const r = errorResponse(new ForbiddenError("nope"));
  assertEquals(r.status, 403);
  const b = await r.json();
  assertEquals(b.code, "forbidden");
  assertEquals(b.error, "nope");
});

Deno.test("errorResponse hides unknown errors as an opaque 500", async () => {
  const r = errorResponse(new Error("secret internal detail"));
  assertEquals(r.status, 500);
  const b = await r.json();
  assertEquals(b.error, "internal error");
  assertEquals(String(b.error).includes("secret"), false);
});

Deno.test("UnauthorizedError carries 401 and is an EnterpriseError", () => {
  const e = new UnauthorizedError();
  assertEquals(e.status, 401);
  assertEquals(e instanceof EnterpriseError, true);
});

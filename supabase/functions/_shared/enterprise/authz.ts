// Enterprise middleware — AUTHORIZATION.
//
// Pure, synchronous role/owner checks plus the enterprise entitlement gate.
// Handlers call requireEnterprise() first (may the caller use the platform at
// all?) then a role/context guard for the specific action.
//
// PRIVATE BETA (see enterprise-private-beta-gate): the platform is gated to the
// owner account (isOwnerEmail) OR any user with an active-org entitlement.
// During the beta the owner is the only one who passes, and the owner email is a
// hard kill-switch. Monetization later relies solely on the active-org path —
// this gate does not change, which is why the real entitlement path is used now.
import type { DbClient } from "./clients.ts";
import type { Actor } from "./auth.ts";
import { ForbiddenError } from "./errors.ts";
import { isOwnerEmail } from "../entitlements.ts";
import { hasActiveOrgEntitlement } from "./context.ts";

export function isOwner(actor: Actor): boolean {
  return isOwnerEmail(actor.email);
}

export function isAdmin(actor: Actor): boolean {
  return isOwner(actor) || actor.role === "admin";
}

export function hasRole(actor: Actor, ...roles: string[]): boolean {
  return actor.role != null && roles.includes(actor.role);
}

export async function isEnterpriseEnabled(actor: Actor, client: DbClient): Promise<boolean> {
  if (isOwner(actor)) return true;
  return hasActiveOrgEntitlement(client, actor.userId);
}

// ── Guards (throw ForbiddenError) ──────────────────────────────────────────
export async function requireEnterprise(actor: Actor, client: DbClient): Promise<void> {
  if (!(await isEnterpriseEnabled(actor, client))) {
    throw new ForbiddenError("enterprise access is not enabled for this account");
  }
}

export function requireRole(actor: Actor, ...roles: string[]): void {
  if (isOwner(actor)) return; // owner overrides every role check
  if (!hasRole(actor, ...roles)) {
    throw new ForbiddenError(`requires role: ${roles.join(" | ")}`);
  }
}

export function requireAdmin(actor: Actor): void {
  if (!isAdmin(actor)) throw new ForbiddenError("requires admin");
}

// ── Review Console RBAC (S2) ────────────────────────────────────────────────
// Reviewer roles may review/correct AI conclusions; only senior/chief (+admin)
// give the binding VERIFY. reviewer_role is otherwise free text (future disciplines:
// gis_analyst, metallurgist, environmental_specialist, external_consultant) — those
// are added to REVIEW_ROLES when introduced, no schema change.
export const REVIEW_ROLES = ["geologist", "senior_geologist", "chief_geologist", "admin"];
export const VERIFY_ROLES = ["senior_geologist", "chief_geologist", "admin"];

export function canReview(actor: Actor): boolean {
  return isOwner(actor) || REVIEW_ROLES.includes(actor.role ?? "");
}
export function canVerify(actor: Actor): boolean {
  return isOwner(actor) || VERIFY_ROLES.includes(actor.role ?? "");
}
export function requireReviewer(actor: Actor): void {
  if (!canReview(actor)) throw new ForbiddenError("requires a reviewer role (geologist+)");
}
export function requireVerifier(actor: Actor): void {
  if (!canVerify(actor)) throw new ForbiddenError("only a senior/chief geologist can verify");
}

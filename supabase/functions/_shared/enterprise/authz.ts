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
import { isOwnerEmail, resolveEffectiveTier } from "../entitlements.ts";
import { hasActiveOrgEntitlement } from "./context.ts";

// Consumer plan that unlocks the PERSONAL sample workflow (collect/scan a
// specimen, run the Geological Intelligence Engine on it). ONLY Gem Collector
// ($14.99) — the Explorer ($4.99 / premium) tier is deliberately excluded. The
// exploration lane (missions, org data) stays enterprise-only.
const PERSONAL_SAMPLE_TIERS = ["professional"];

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

// Access to the PERSONAL sample workflow: owner, an active-org member (they
// already have the full platform), OR a paid consumer plan (Explorer / Gem
// Collector). This is a SUPERSET of requireEnterprise — anyone requireEnterprise
// admits also passes here — so it is the right default gate for reading and
// managing one's OWN samples; the stricter requireEnterprise is layered on top
// only for creating EXPLORATION-lane evidence.
export async function requirePersonalSampleAccess(actor: Actor, client: DbClient): Promise<void> {
  if (await isEnterpriseEnabled(actor, client)) return; // owner or active org
  // subscriptions lives in public; our enterprise client must hop schemas.
  const { data: sub } = await client
    .schema("public")
    .from("subscriptions")
    .select("tier, status")
    .eq("user_id", actor.userId)
    .maybeSingle();
  const tier = resolveEffectiveTier(actor.email, sub);
  if (PERSONAL_SAMPLE_TIERS.includes(tier)) return;
  throw new ForbiddenError(
    "the Gem Collector plan is required to collect and analyze samples",
  );
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

// Enterprise middleware — LAZY CONTEXT.
//
// Authorization-context lookups a handler calls only for the specific
// org/project/mission it is acting on. resolveActor never preloads these.
// Pass a serviceClient to make an authorization decision that must not be
// filtered by RLS; pass a userClient to respect RLS. These mirror the SQL RLS
// helpers (enterprise.is_org_member / is_project_member / is_mission_member) so
// the app-side and DB-side authorization stay in agreement.
import type { DbClient } from "./clients.ts";

export async function isOrgMember(client: DbClient, userId: string, orgId: string): Promise<boolean> {
  const { data } = await client
    .from("organization_member")
    .select("user_id")
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  return data != null;
}

export async function orgRoleOf(client: DbClient, userId: string, orgId: string): Promise<string | null> {
  const { data } = await client
    .from("organization_member")
    .select("role")
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  return (data?.role as string | undefined) ?? null;
}

// Production enterprise-entitlement signal: does the user belong to ANY
// organization whose status is 'active'? (org-level entitlement.)
export async function hasActiveOrgEntitlement(client: DbClient, userId: string): Promise<boolean> {
  const { data, error } = await client
    .from("organization_member")
    .select("organization_id, organization!inner(status)")
    .eq("user_id", userId)
    .eq("organization.status", "active")
    .limit(1);
  if (error) return false;
  return (data?.length ?? 0) > 0;
}

export async function isProjectMember(client: DbClient, userId: string, projectId: string): Promise<boolean> {
  const { data: proj } = await client
    .from("project")
    .select("organization_id")
    .eq("id", projectId)
    .maybeSingle();
  const orgId = proj?.organization_id as string | undefined;
  if (!orgId) return false;
  return isOrgMember(client, userId, orgId);
}

export async function isMissionMember(client: DbClient, userId: string, missionId: string): Promise<boolean> {
  const { data: m } = await client
    .from("exploration_mission")
    .select("owner_id, project_id")
    .eq("id", missionId)
    .maybeSingle();
  if (!m) return false;
  if (m.owner_id === userId) return true;

  const { data: roster } = await client
    .from("mission_contributor")
    .select("contributor_id")
    .eq("mission_id", missionId)
    .eq("contributor_id", userId)
    .maybeSingle();
  if (roster != null) return true;

  const projectId = m.project_id as string | undefined;
  if (projectId) return isProjectMember(client, userId, projectId);
  return false;
}

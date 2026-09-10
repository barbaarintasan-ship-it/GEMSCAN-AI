// Enterprise team management — self-serve add/remove of org teammates.
//
// Thin wrapper over the enterprise.* SECURITY DEFINER RPCs (migration 0110).
// Like enterpriseSamples.ts, this stays deliberately dumb: authorization
// (owner/admin only, seat cap) is enforced entirely in the RPCs, not here.
import { supabase } from "../supabase";

export type OrgRole = "owner" | "admin" | "member" | "viewer";

export type MyOrganization = {
  organization_id: string;
  name: string;
  plan: string;
  status: string;
  my_role: OrgRole;
  max_seats: number | null;
  seats_used: number;
};

export type OrgMember = {
  user_id: string;
  email: string;
  role: OrgRole;
  joined_at: string;
};

export async function fetchMyOrganizations(): Promise<MyOrganization[]> {
  const { data, error } = await supabase.schema("enterprise").rpc("my_organizations");
  if (error) throw error;
  return (data ?? []) as MyOrganization[];
}

export async function fetchOrgMembers(organizationId: string): Promise<OrgMember[]> {
  const { data, error } = await supabase.schema("enterprise")
    .rpc("list_org_members", { p_org: organizationId });
  if (error) throw error;
  return (data ?? []) as OrgMember[];
}

// Errors from add_org_member_by_email are prefixed by the RPC ("no_account: …",
// "seat_limit_reached: …", "forbidden: …") — callers can match on these to show
// a specific message rather than a generic failure. The RPC returns void —
// the caller re-fetches the roster (fetchOrgMembers) to see the new member.
export async function addOrgMemberByEmail(organizationId: string, email: string): Promise<void> {
  const { error } = await supabase.schema("enterprise").rpc("add_org_member_by_email", {
    p_org: organizationId,
    p_email: email.trim(),
  });
  if (error) throw error;
}

export async function removeOrgMember(organizationId: string, userId: string): Promise<void> {
  const { error } = await supabase.schema("enterprise").rpc("remove_org_member", {
    p_org: organizationId,
    p_user_id: userId,
  });
  if (error) throw error;
}

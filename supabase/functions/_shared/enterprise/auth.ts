// Enterprise middleware — AUTHENTICATION.
//
// resolveActor() verifies the caller's JWT and returns their MINIMAL identity.
// Organization / project / mission / area context is intentionally NOT loaded
// here — a handler pulls only what it needs, lazily, from context.ts. Keeping
// resolveActor cheap means it is safe to call at the top of every request.
import { serviceClient, userClient } from "./clients.ts";
import { UnauthorizedError } from "./errors.ts";

export interface Actor {
  userId: string;                // auth.users.id
  email: string | null;          // from the verified JWT
  contributorId: string | null;  // enterprise.field_contributor.id, if provisioned
  role: string | null;           // contributor_role, or null when not a contributor
}

export async function resolveActor(req: Request): Promise<Actor> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) throw new UnauthorizedError("missing Authorization header");

  // Verify the JWT by asking the auth server who this token belongs to.
  const { data: { user }, error } = await userClient(req).auth.getUser();
  if (error || !user) throw new UnauthorizedError("invalid or expired token");

  // Contributor role is looked up with the service client (bypasses RLS) so a
  // user with no field_contributor row resolves to role=null instead of erroring
  // — enterprise entitlement is decided separately in authz.ts.
  const { data: fc } = await serviceClient()
    .from("field_contributor")
    .select("id, role")
    .eq("user_id", user.id)
    .maybeSingle();

  return {
    userId: user.id,
    email: user.email ?? null,
    contributorId: (fc?.id as string | undefined) ?? null,
    role: (fc?.role as string | undefined) ?? null,
  };
}

// Enterprise reference function — CONTEXT / "who am I in the enterprise platform".
//
// The first consumer of the 4.1.a middleware: it proves the whole chain end to
// end — JWT → resolveActor (identity) → enterprise entitlement gate — and returns
// the caller's resolved context. Read-only; performs no writes.
//
// This is a STATUS endpoint (not an action), so a caller who is not enterprise-
// enabled still gets a clear 200 answer (enterpriseEnabled:false) rather than a
// 403 — the app uses it to decide whether to show the enterprise surface. Action
// endpoints (sample submission, verification, …) will instead call
// requireEnterprise() and hard-fail with 403.
//
// Dependencies are injected so the handler is unit-testable without a live stack.
import { corsHeaders } from "../_shared/cors.ts";
import { errorResponse, json } from "../_shared/enterprise/errors.ts";
import { resolveActor as realResolveActor, type Actor } from "../_shared/enterprise/auth.ts";
import { serviceClient } from "../_shared/enterprise/clients.ts";
import { isEnterpriseEnabled as realIsEnterpriseEnabled, isOwner } from "../_shared/enterprise/authz.ts";

export interface ContextDeps {
  resolveActor: (req: Request) => Promise<Actor>;
  isEnterpriseEnabled: (actor: Actor) => Promise<boolean>;
}

export const defaultDeps: ContextDeps = {
  resolveActor: realResolveActor,
  isEnterpriseEnabled: (actor) => realIsEnterpriseEnabled(actor, serviceClient()),
};

export async function handleContext(req: Request, deps: ContextDeps = defaultDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const actor = await deps.resolveActor(req); // throws UnauthorizedError on bad/missing JWT
    const enabled = await deps.isEnterpriseEnabled(actor);

    if (!enabled) {
      return json({
        userId: actor.userId,
        email: actor.email,
        enterpriseEnabled: false,
        reason: "not in private beta / no active organization",
      });
    }

    return json({
      userId: actor.userId,
      email: actor.email,
      contributorId: actor.contributorId,
      role: actor.role,
      isOwner: isOwner(actor),
      enterpriseEnabled: true,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

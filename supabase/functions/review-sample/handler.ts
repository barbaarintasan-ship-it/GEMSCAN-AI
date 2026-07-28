// review-sample — the permanent geologist review endpoint (Review Console S2).
//   POST /review-sample  { sample_id, decision, geologist_confidence, corrected_interpretation,
//                          review_notes, recommendation, evidence_references, conclusions[] }
//   decision ∈ verify | needs_more_data | reject | draft (omit/"draft" = Save Draft).
//
// Auth: resolveActor (JWT) → requireEnterprise → requireReviewer; a binding VERIFY
// additionally requires requireVerifier (senior/chief). The atomic enterprise.review_sample
// RPC does the rest (review object, per-conclusion states, lifecycle, discussion,
// notifications, audit) without ever overwriting the AI assessment. Deps injected.
import { corsHeaders } from "../_shared/cors.ts";
import { BadRequestError, errorResponse, json } from "../_shared/enterprise/errors.ts";
import { resolveActor as realResolveActor, type Actor } from "../_shared/enterprise/auth.ts";
import { serviceClient } from "../_shared/enterprise/clients.ts";
import {
  requireEnterprise as realRequireEnterprise,
  requireReviewer as realRequireReviewer,
  requireVerifier as realRequireVerifier,
} from "../_shared/enterprise/authz.ts";

const DECISIONS = ["verify", "needs_more_data", "reject", "draft"];

export interface Deps {
  resolveActor: (req: Request) => Promise<Actor>;
  requireEnterprise: (actor: Actor) => Promise<void>;
  requireReviewer: (actor: Actor) => void;
  requireVerifier: (actor: Actor) => void;
  submitReview: (actor: Actor, payload: Record<string, unknown>) => Promise<unknown>;
}

export const defaultDeps: Deps = {
  resolveActor: realResolveActor,
  requireEnterprise: (a) => realRequireEnterprise(a, serviceClient()),
  requireReviewer: realRequireReviewer,
  requireVerifier: realRequireVerifier,
  submitReview: async (actor, payload) => {
    const { data, error } = await serviceClient().rpc("review_sample", { p_actor: actor.userId, p_payload: payload });
    if (error) {
      if (/validation:/i.test(error.message)) throw new BadRequestError(error.message.replace(/^.*validation:\s*/i, ""));
      throw new Error(`review_sample: ${error.message}`);
    }
    return data;
  },
};

export function buildReviewPayload(actor: Actor, body: Record<string, unknown>): Record<string, unknown> {
  if (!body.sample_id || typeof body.sample_id !== "string") throw new BadRequestError("sample_id is required");
  const decision = body.decision == null || body.decision === "" ? "draft" : String(body.decision);
  if (!DECISIONS.includes(decision)) throw new BadRequestError(`invalid decision: ${decision}`);
  return {
    sample_id: body.sample_id,
    decision,
    // reviewer_role defaults to the actor's role; free text keeps future disciplines open.
    reviewer_role: (typeof body.reviewer_role === "string" && body.reviewer_role) || actor.role || "geologist",
    geologist_confidence: body.geologist_confidence ?? undefined,
    corrected_interpretation: body.corrected_interpretation ?? undefined,
    review_notes: body.review_notes ?? undefined,
    recommendation: body.recommendation ?? undefined,
    evidence_references: Array.isArray(body.evidence_references) ? body.evidence_references : [],
    conclusions: Array.isArray(body.conclusions) ? body.conclusions : [],
    _decision: decision,
  };
}

export async function handleReview(req: Request, deps: Deps = defaultDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const actor = await deps.resolveActor(req);
    await deps.requireEnterprise(actor);
    deps.requireReviewer(actor);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const payload = buildReviewPayload(actor, body);
    // A binding VERIFY requires senior/chief; drafts, reject, needs_more_data need only reviewer.
    if (payload._decision === "verify") deps.requireVerifier(actor);
    delete (payload as { _decision?: string })._decision;

    const result = await deps.submitReview(actor, payload);
    return json(result ?? {}, 200);
  } catch (err) {
    return errorResponse(err);
  }
}

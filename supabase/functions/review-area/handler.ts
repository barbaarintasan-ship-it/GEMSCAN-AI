// review-area Edge Function — Phase 11 (Geological Intelligence Transformation).
//
// The human-review write path for a mission's exploration_area:
//   POST /review-area  { missionId, areaId, decision, notes? }
// `decision` is one of "accepted" | "rejected" | "needs_more_data".
//
// AUTHORITATIVE BOUNDARY (restated from enterprise.review_area's own
// header note): the deterministic engine stays authoritative for
// prospectivity_score/evidence/reasons/coverage (Phase 10), AI stays
// authoritative for nothing, and this endpoint is authoritative ONLY for
// review_status/reviewed_by/reviewed_at/review_notes. Nothing here reads
// or writes a score. The RPC itself derives reviewed_by/reviewed_at from
// auth.uid()/now() server-side — the request body's identity claims (if
// any) are never trusted, same discipline as accept-recommended-area's
// own server-authoritative re-scoring.
//
// Authorization is entirely the RPC's is_mission_manager(p_mission) check
// (see 0145's own comment for why this boundary, not authz.ts's
// REVIEW_ROLES) — this handler does zero role logic itself, same shape as
// accept-recommended-area/create-manual-area.
import { corsHeaders } from "../_shared/cors.ts";
import { BadRequestError, errorResponse, json } from "../_shared/enterprise/errors.ts";
import { resolveActor as realResolveActor, type Actor } from "../_shared/enterprise/auth.ts";
import { userClient, type DbClient } from "../_shared/enterprise/clients.ts";

export const REVIEW_DECISIONS = ["accepted", "rejected", "needs_more_data"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export interface ReviewAreaResponse {
  areaId: string;
  reviewStatus: ReviewDecision;
  reviewedBy: string;
  reviewedAt: string;
}

export interface ReviewAreaDeps {
  resolveActor: (req: Request) => Promise<Actor>;
  userClient: (req: Request) => DbClient;
}

export const defaultDeps: ReviewAreaDeps = {
  resolveActor: realResolveActor,
  userClient: (req) => userClient(req),
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

export async function handleReviewArea(
  req: Request,
  deps: ReviewAreaDeps = defaultDeps,
): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await deps.resolveActor(req); // verifies the JWT; the RPC re-derives auth.uid() from the forwarded token.

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const missionId = str(body.missionId);
    const areaId = str(body.areaId);
    const decisionRaw = str(body.decision);
    const notes = str(body.notes);

    if (!missionId) throw new BadRequestError("missionId is required");
    if (!areaId) throw new BadRequestError("areaId is required");
    if (!decisionRaw || !(REVIEW_DECISIONS as readonly string[]).includes(decisionRaw)) {
      throw new BadRequestError(`decision must be one of ${REVIEW_DECISIONS.join(", ")}`);
    }
    const decision = decisionRaw as ReviewDecision;

    const client = deps.userClient(req);
    const { data, error } = await client.schema("enterprise").rpc("review_area", {
      p_mission: missionId,
      p_area: areaId,
      p_decision: decision,
      p_notes: notes,
    });
    if (error) throw new BadRequestError(error.message);

    const result = data as { area_id: string; review_status: string; reviewed_by: string; reviewed_at: string };
    const response: ReviewAreaResponse = {
      areaId: result.area_id,
      reviewStatus: result.review_status as ReviewDecision,
      reviewedBy: result.reviewed_by,
      reviewedAt: result.reviewed_at,
    };
    return json(response, 200);
  } catch (err) {
    return errorResponse(err);
  }
}

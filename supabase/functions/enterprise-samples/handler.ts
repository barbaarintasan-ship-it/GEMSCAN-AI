// enterprise-samples — Sample Submission API (Sprint 4.2, owner beta).
//   POST  /enterprise-samples        create a sample (+location+observations+media+audit)
//   GET   /enterprise-samples        list the caller's samples (RLS-scoped)
//   GET   /enterprise-samples/:id    one sample with nested detail (RLS-scoped)
//
// Writes go through the atomic enterprise.submit_sample RPC (service role); reads use
// the user-scoped client so existing RLS policies apply. Deps are injected for tests.
import { corsHeaders } from "../_shared/cors.ts";
import { BadRequestError, ConflictError, errorResponse, ForbiddenError, json, NotFoundError } from "../_shared/enterprise/errors.ts";
import { resolveActor as realResolveActor, type Actor } from "../_shared/enterprise/auth.ts";
import { serviceClient, userClient } from "../_shared/enterprise/clients.ts";
import { requireEnterprise as realRequireEnterprise } from "../_shared/enterprise/authz.ts";
import { cellFor } from "../_shared/geocontext/h3.ts";

const MEDIA_ROLES = ["context", "surface_closeup", "texture_structure", "key_feature", "scale_reference", "extra"];
const CLOSEUP_ROLES = ["surface_closeup", "texture_structure", "key_feature"]; // count as a "specimen close-up"
const GPS_SOURCES = ["gps", "fused", "network", "manual"];
const H3_RES = 9; // ~174 m cells for sample points
const LIST_COLS = "id,name,collected_at,status,completeness_status,completeness_score," +
  "ai_confidence,geologist_confidence,confidence_score,area_id,created_at";
const DETAIL = "id,name,collected_at,status,completeness_status,completeness_score," +
  "ai_confidence,geologist_confidence,confidence_score,area_id,field_observations,created_at," +
  // Why the last run failed, so the app can say so instead of showing
  // "Submitted" over a sample whose analysis died hours ago.
  "ai_error,ai_attempted_at," +
  "sample_location(altitude_m,gps_accuracy_m,h3_cell,provenance)," +
  "sample_media(id,role,storage_path,thumb_path)," +
  "rock_observation(rock_class,host_type,texture,weathering,vein_presence,notes)," +
  "mineral_observation(mineral,confidence),alteration_observation(alteration_type,intensity,notes)," +
  "structural_measurement(structure_type,strike_deg,dip_deg,dip_direction,notes)";

export interface Deps {
  resolveActor: (req: Request) => Promise<Actor>;
  requireEnterprise: (actor: Actor) => Promise<void>;
  createSample: (actor: Actor, payload: Record<string, unknown>) => Promise<unknown>;
  editSample: (actor: Actor, id: string, payload: Record<string, unknown>) => Promise<unknown>;
  listSamples: (req: Request, actor: Actor) => Promise<unknown>;
  getSample: (req: Request, actor: Actor, id: string) => Promise<unknown | null>;
  reanalyze: (actor: Actor, id: string) => Promise<void>;
  deleteSample: (actor: Actor, id: string) => Promise<void>;
}

export const defaultDeps: Deps = {
  resolveActor: realResolveActor,
  requireEnterprise: (a) => realRequireEnterprise(a, serviceClient()),
  createSample: async (actor, payload) => {
    const svc = serviceClient();
    const { data, error } = await svc.rpc("submit_sample", { p_actor: actor.userId, p_payload: payload });
    // The RPC raises 'validation: …' for a bad request — surface that as a 400.
    if (error) {
      if (/validation:/i.test(error.message)) throw new BadRequestError(error.message.replace(/^.*validation:\s*/i, ""));
      throw new Error(`submit_sample: ${error.message}`);
    }
    const id = (data as { sample_id: string }).sample_id;
    triggerAnalysis(id); // auto-run the Geological Intelligence Engine (non-blocking, §6)
    const { data: detail } = await svc.from("sample").select(DETAIL).eq("id", id).maybeSingle();
    return { ...(data as object), sample: detail };
  },
  editSample: async (actor, id, payload) => {
    const svc = serviceClient();
    const { data, error } = await svc.rpc("edit_sample", { p_actor: actor.userId, p_sample: id, p_payload: payload });
    // The RPC raises typed prefixes; map each to the right HTTP status.
    if (error) {
      const m = error.message;
      if (/not_found:/i.test(m)) throw new NotFoundError(m.replace(/^.*not_found:\s*/i, ""));
      if (/forbidden:/i.test(m)) throw new ForbiddenError(m.replace(/^.*forbidden:\s*/i, ""));
      if (/locked:/i.test(m)) throw new ConflictError(m.replace(/^.*locked:\s*/i, ""));
      if (/validation:/i.test(m)) throw new BadRequestError(m.replace(/^.*validation:\s*/i, ""));
      throw new Error(`edit_sample: ${m}`);
    }
    // A fresh assessment must be regenerated from the edited data (replaces the one
    // the RPC just deleted). Force = new input hash so the newest write wins.
    triggerAnalysis(id, true);
    const { data: detail } = await svc.from("sample").select(DETAIL).eq("id", id).maybeSingle();
    return { ...(data as object), sample: detail };
  },
  listSamples: async (req, actor) => {
    const { data, error } = await userClient(req).from("sample")
      .select(LIST_COLS)
      .eq("collector_id", actor.userId).is("deleted_at", null).order("created_at", { ascending: false });
    if (error) throw new Error(`list: ${error.message}`);
    return data ?? [];
  },
  reanalyze: (_actor, id) => { triggerAnalysis(id, true); return Promise.resolve(); },
  deleteSample: async (actor, id) => {
    const svc = serviceClient();
    const { data, error } = await svc.rpc("delete_sample", { p_actor: actor.userId, p_sample: id });
    if (error) {
      const m = error.message;
      if (/not_found:/i.test(m)) throw new NotFoundError(m.replace(/^.*not_found:\s*/i, ""));
      if (/forbidden:/i.test(m)) throw new ForbiddenError(m.replace(/^.*forbidden:\s*/i, ""));
      if (/locked:/i.test(m)) throw new ConflictError(m.replace(/^.*locked:\s*/i, ""));
      throw new Error(`delete_sample: ${m}`);
    }
    // The photos go too — the collector asked for the sample to be gone, and
    // leaving megabytes of orphaned storage behind is not "deleted". Failures
    // here are logged, not raised: the sample IS deleted from every read path,
    // and reporting an error would suggest otherwise.
    const paths = ((data as { media_paths?: string[] } | null)?.media_paths ?? []).filter(Boolean);
    if (paths.length) {
      const { error: rmErr } = await svc.storage.from("scan-images").remove(paths);
      if (rmErr) console.error(`delete_sample ${id}: storage cleanup failed — ${rmErr.message}`);
    }
  },
  getSample: async (req, actor, id) => {
    const uc = userClient(req);
    const { data } = await uc.from("sample").select(DETAIL).eq("id", id).maybeSingle();
    if (!data) return null;
    // Latest geological assessment (RLS: can_read_assessment) + its evidence graph.
    const { data: assessment } = await userClient(req, "geo").from("geological_assessment")
      .select("id,overall_confidence,status,report,created_at," +
        "assessment_conclusion(id,kind,statement,statement_so,is_interpretation,confidence)," +
        "assessment_evidence(id,source,ev_type,statement,statement_so,is_observation,tier,quality)," +
        "assessment_edge(conclusion_id,evidence_id,polarity,contribution,effective_weight)")
      .eq("sample_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    // Geologist's latest binding review + the discussion timeline, so the collector
    // actually SEES the reviewer's decision, confidence, notes and messages (RLS:
    // can_read_sample lets the collector read their own sample's review/discussion).
    const { data: review } = await uc.from("sample_review")
      .select("id,round_no,status,decision,geologist_confidence,corrected_interpretation,review_notes,recommendation,reviewer_role,submitted_at")
      .eq("sample_id", id).eq("status", "submitted").order("round_no", { ascending: false }).limit(1).maybeSingle();
    const { data: discussion } = await uc.from("sample_discussion")
      .select("id,author_role,body,created_at").eq("sample_id", id).order("created_at", { ascending: true });
    return { ...(data as object), assessment: assessment ?? null, review: review ?? null, discussion: discussion ?? [] };
  },
};

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

// Fire-and-forget: kick off analyze-sample right after a submit. Non-blocking so
// the submit response stays fast; EdgeRuntime.waitUntil keeps it alive past the
// response. analyze-sample is idempotent + daily-capped, so this is safe to retry.
function triggerAnalysis(sampleId: string, force = false): void {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return;
  const p = fetch(`${url}/functions/v1/analyze-sample`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ sample_id: sampleId, force }),
  })
    // Swallowing this is what made a real outage invisible: analyze-sample was
    // failing on samples with many photos, and because the rejection was
    // discarded the sample simply sat at "submitted" with nothing recorded
    // anywhere. Fire-and-forget must still REPORT — it just must not block.
    .then(async (res) => {
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`analyze-sample ${sampleId} -> HTTP ${res.status}: ${body.slice(0, 500)}`);
      }
    })
    .catch((e) => console.error(`analyze-sample ${sampleId} -> request failed:`, e));
  // deno-lint-ignore no-explicit-any
  const er = (globalThis as any).EdgeRuntime;
  if (er?.waitUntil) er.waitUntil(p);
}

// Validate + normalize the POST body into the RPC payload (throws BadRequestError).
// This is the authoritative SERVER-side validation (§4/§15) — the mobile client
// mirrors it for UX, and the RPC guards again as defense-in-depth.
export function buildPayload(body: Record<string, unknown>): Record<string, unknown> {
  // Sample name (§1)
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) throw new BadRequestError("sample name is required");

  // GPS (§2)
  const lat = num(body.lat), lng = num(body.lng);
  if (lat === null || lng === null) throw new BadRequestError("GPS (lat/lng) is required");
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new BadRequestError("GPS coordinates out of range");
  if (body.gps_source && !GPS_SOURCES.includes(String(body.gps_source))) throw new BadRequestError("invalid gps_source");

  // Collection date (§4)
  if (!body.collected_at) throw new BadRequestError("collection date is required");

  // Media + photo minimums (§3): >=1 context and >=1 close-up
  const media = Array.isArray(body.media) ? body.media : [];
  let contextPhotos = 0, closeupPhotos = 0;
  for (const m of media as Array<Record<string, unknown>>) {
    if (!m || !MEDIA_ROLES.includes(String(m.role))) throw new BadRequestError(`invalid media role: ${m?.role}`);
    if (!m.storage_path) throw new BadRequestError("each media item needs storage_path");
    if (m.role === "context") contextPhotos++;
    if (CLOSEUP_ROLES.includes(String(m.role))) closeupPhotos++;
  }
  if (contextPhotos === 0) throw new BadRequestError("a field-context photo is required");
  if (closeupPhotos === 0) throw new BadRequestError("a specimen close-up photo is required");

  // Geology is OPTIONAL — the AI determines host rock / minerals. The collector may
  // add them if known, but they never block a submission.
  const obs = (body.observations ?? {}) as Record<string, unknown>;

  return {
    name,
    lat, lng, h3_cell: cellFor(lat, lng, H3_RES),
    altitude_m: num(body.altitude_m) ?? undefined, gps_accuracy_m: num(body.gps_accuracy_m) ?? undefined,
    gps_source: body.gps_source ?? "gps", collected_at: body.collected_at,
    area_id: body.area_id ?? undefined, terrain_type: body.terrain_type ?? undefined,
    sample_method: body.sample_method ?? undefined, host_context: body.host_context ?? undefined,
    rock_condition: body.rock_condition ?? undefined, in_situ: body.in_situ ?? undefined,
    geological_environment: body.geological_environment ?? undefined,
    weather_conditions: body.weather_conditions ?? undefined,
    field_observations: body.field_observations ?? undefined,
    media, observations: obs,
  };
}

export async function handleSamples(req: Request, deps: Deps = defaultDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const actor = await deps.resolveActor(req);
    await deps.requireEnterprise(actor);
    const parts = new URL(req.url).pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("enterprise-samples");
    const id = idx >= 0 && parts[idx + 1] ? parts[idx + 1] : (parts.length && parts[parts.length - 1] !== "enterprise-samples" ? parts[parts.length - 1] : null);

    // PUT /enterprise-samples/:id → edit + re-submit a sample the caller collected,
    // as long as a geologist hasn't reviewed it yet (the RPC enforces the gate and
    // kicks off a fresh AI analysis). Only samples the caller can read (RLS) proceed.
    if (req.method === "PUT" && id) {
      const s = await deps.getSample(req, actor, id);
      if (!s) throw new NotFoundError("sample not found");
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const updated = await deps.editSample(actor, id, buildPayload(body));
      return json(updated, 200);
    }

    // POST /enterprise-samples/:id → force a re-analysis of that sample (owner or,
    // later, a geologist). Only samples the caller can read (RLS) can be re-run.
    if (req.method === "POST" && id) {
      const s = await deps.getSample(req, actor, id);
      if (!s) throw new NotFoundError("sample not found");
      await deps.reanalyze(actor, id);
      return json({ status: "reanalyzing", sample_id: id }, 202);
    }

    // DELETE /enterprise-samples/:id → the collector clears their own sample.
    // Ownership, status and audit are all enforced in the RPC, so this route
    // adds no second opinion about who may delete what.
    if (req.method === "DELETE" && id) {
      await deps.deleteSample(actor, id);
      return json({ status: "deleted", sample_id: id }, 200);
    }
    if (req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const created = await deps.createSample(actor, buildPayload(body));
      return json(created, 201);
    }
    if (req.method === "GET" && id) {
      const s = await deps.getSample(req, actor, id);
      if (!s) throw new NotFoundError("sample not found");
      return json(s);
    }
    if (req.method === "GET") return json({ samples: await deps.listSamples(req, actor) });
    return json({ error: "method not allowed" }, 405);
  } catch (err) {
    return errorResponse(err);
  }
}

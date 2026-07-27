// enterprise-samples — Sample Submission API (Sprint 4.2, owner beta).
//   POST  /enterprise-samples        create a sample (+location+observations+media+audit)
//   GET   /enterprise-samples        list the caller's samples (RLS-scoped)
//   GET   /enterprise-samples/:id    one sample with nested detail (RLS-scoped)
//
// Writes go through the atomic enterprise.submit_sample RPC (service role); reads use
// the user-scoped client so existing RLS policies apply. Deps are injected for tests.
import { corsHeaders } from "../_shared/cors.ts";
import { BadRequestError, errorResponse, json, NotFoundError } from "../_shared/enterprise/errors.ts";
import { resolveActor as realResolveActor, type Actor } from "../_shared/enterprise/auth.ts";
import { serviceClient, userClient } from "../_shared/enterprise/clients.ts";
import { requireEnterprise as realRequireEnterprise } from "../_shared/enterprise/authz.ts";
import { cellFor } from "../_shared/geocontext/h3.ts";

const MEDIA_ROLES = ["context", "surface_closeup", "texture_structure", "key_feature", "scale_reference", "extra"];
const GPS_SOURCES = ["gps", "fused", "network", "manual"];
const H3_RES = 9; // ~174 m cells for sample points
const DETAIL = "id,collected_at,status,completeness_status,confidence_score,area_id,field_observations,created_at," +
  "sample_location(altitude_m,gps_accuracy_m,h3_cell,provenance)," +
  "sample_media(id,role,storage_path,thumb_path)," +
  "rock_observation(rock_class,host_type,texture,weathering,vein_presence,notes)," +
  "mineral_observation(mineral,confidence),alteration_observation(alteration_type,intensity,notes)," +
  "structural_measurement(structure_type,strike_deg,dip_deg,dip_direction,notes)";

export interface Deps {
  resolveActor: (req: Request) => Promise<Actor>;
  requireEnterprise: (actor: Actor) => Promise<void>;
  createSample: (actor: Actor, payload: Record<string, unknown>) => Promise<unknown>;
  listSamples: (req: Request, actor: Actor) => Promise<unknown>;
  getSample: (req: Request, actor: Actor, id: string) => Promise<unknown | null>;
}

export const defaultDeps: Deps = {
  resolveActor: realResolveActor,
  requireEnterprise: (a) => realRequireEnterprise(a, serviceClient()),
  createSample: async (actor, payload) => {
    const svc = serviceClient();
    const { data, error } = await svc.rpc("submit_sample", { p_actor: actor.userId, p_payload: payload });
    if (error) throw new Error(`submit_sample: ${error.message}`);
    const id = (data as { sample_id: string }).sample_id;
    const { data: detail } = await svc.from("sample").select(DETAIL).eq("id", id).maybeSingle();
    return { ...(data as object), sample: detail };
  },
  listSamples: async (req, actor) => {
    const { data, error } = await userClient(req).from("sample")
      .select("id,collected_at,status,completeness_status,confidence_score,area_id,created_at")
      .eq("collector_id", actor.userId).is("deleted_at", null).order("created_at", { ascending: false });
    if (error) throw new Error(`list: ${error.message}`);
    return data ?? [];
  },
  getSample: async (req, actor, id) => {
    const { data } = await userClient(req).from("sample").select(DETAIL).eq("id", id).maybeSingle();
    return data ?? null;
  },
};

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

// Validate + normalize the POST body into the RPC payload (throws BadRequestError).
export function buildPayload(body: Record<string, unknown>): Record<string, unknown> {
  const lat = num(body.lat), lng = num(body.lng);
  if (lat === null || lng === null) throw new BadRequestError("lat and lng are required numbers");
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new BadRequestError("lat/lng out of range");
  if (body.gps_source && !GPS_SOURCES.includes(String(body.gps_source))) throw new BadRequestError("invalid gps_source");
  const media = Array.isArray(body.media) ? body.media : [];
  for (const m of media as Array<Record<string, unknown>>) {
    if (!m || !MEDIA_ROLES.includes(String(m.role))) throw new BadRequestError(`invalid media role: ${m?.role}`);
    if (!m.storage_path) throw new BadRequestError("each media item needs storage_path");
  }
  return {
    lat, lng, h3_cell: cellFor(lat, lng, H3_RES),
    altitude_m: num(body.altitude_m) ?? undefined, gps_accuracy_m: num(body.gps_accuracy_m) ?? undefined,
    gps_source: body.gps_source ?? "gps", collected_at: body.collected_at ?? undefined,
    area_id: body.area_id ?? undefined, terrain_type: body.terrain_type ?? undefined,
    sample_method: body.sample_method ?? undefined, host_context: body.host_context ?? undefined,
    rock_condition: body.rock_condition ?? undefined, in_situ: body.in_situ ?? undefined,
    geological_environment: body.geological_environment ?? undefined,
    weather_conditions: body.weather_conditions ?? undefined,
    field_observations: body.field_observations ?? undefined,
    media, observations: body.observations ?? {},
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

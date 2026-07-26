// geocontext Edge Function — the GeoContext runtime endpoint.
//
// Flow: resolveActor (JWT) → requireEnterprise (private-beta gate) → build the
// engine over the production Supabase gateway + cache → engine.run(query) →
// GeoContext JSON (with the explainable evidence section). Never calls an LLM.
//
// Dependencies are injected so the handler is unit-testable without a live stack.
import { corsHeaders } from "../_shared/cors.ts";
import { BadRequestError, errorResponse, json } from "../_shared/enterprise/errors.ts";
import { resolveActor as realResolveActor, type Actor } from "../_shared/enterprise/auth.ts";
import { serviceClient } from "../_shared/enterprise/clients.ts";
import { requireEnterprise as realRequireEnterprise } from "../_shared/enterprise/authz.ts";
import { GeoContextEngine } from "../_shared/geocontext/engine.ts";
import { buildProviders } from "../_shared/geocontext/providers/index.ts";
import { makeSupabaseGateway } from "../_shared/geocontext/providers/supabaseGateway.ts";
import { makeSupabaseCacheStore } from "../_shared/geocontext/cacheStore.ts";
import { cellFor } from "../_shared/geocontext/h3.ts";
import type { GeoContext } from "../_shared/geocontext/types.ts";

export const ENGINE_VERSION = "geocontext-1.0.0";
const DEFAULT_RADIUS_M = 25000;
const CACHE_TTL_S = 86400;

export interface ContextDeps {
  resolveActor: (req: Request) => Promise<Actor>;
  requireEnterprise: (actor: Actor) => Promise<void>;
  runEngine: (q: { lat: number; lng: number; radiusM: number; h3: string; mineralHint?: string }) => Promise<GeoContext>;
}

export const defaultDeps: ContextDeps = {
  resolveActor: realResolveActor,
  requireEnterprise: (actor) => realRequireEnterprise(actor, serviceClient()),
  runEngine: (q) => {
    const svc = serviceClient();
    const engine = new GeoContextEngine({
      engineVersion: ENGINE_VERSION,
      providers: buildProviders(makeSupabaseGateway(svc)),
      cache: makeSupabaseCacheStore(svc),
      cacheTtlSeconds: CACHE_TTL_S,
    });
    return engine.run(q);
  },
};

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

export async function handleGeoContext(req: Request, deps: ContextDeps = defaultDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const actor = await deps.resolveActor(req);
    await deps.requireEnterprise(actor); // 403 unless enterprise-enabled

    // Accept GET ?lat&lng&radiusM or POST JSON.
    let body: Record<string, unknown> = {};
    if (req.method === "POST") body = await req.json().catch(() => ({}));
    const url = new URL(req.url);
    const lat = num(body.lat ?? url.searchParams.get("lat"));
    const lng = num(body.lng ?? url.searchParams.get("lng"));
    const radiusM = num(body.radiusM ?? url.searchParams.get("radiusM")) ?? DEFAULT_RADIUS_M;
    const mineralHint = (body.mineralHint ?? url.searchParams.get("mineralHint") ?? undefined) as string | undefined;
    if (lat === null || lng === null) throw new BadRequestError("lat and lng are required");
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new BadRequestError("lat/lng out of range");

    const ctx = await deps.runEngine({ lat, lng, radiusM, h3: cellFor(lat, lng), mineralHint });
    return json(ctx);
  } catch (err) {
    return errorResponse(err);
  }
}

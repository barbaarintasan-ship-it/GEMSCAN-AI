// team-targeting Edge Function — Solo→Team shared-targeting Phase 1.
//
// The smallest server-callable entry point into the SAME deterministic
// TargetingEngine Solo Exploration already uses (shared/geo-core/gie/). Given
// a location, returns ranked target cells with their prospectivity score,
// evidence and (optionally) a hotspot — exactly what TargetingEngine.rank()
// already considers authoritative on-device.
//
// NOT an AI call. Deterministic geological intelligence only, same as
// `geocontext`. Team Mission Mode does not yet CONSUME this (that begins
// Phase 2 — "AI Recommended Area"); this function exists so the seam can be
// tested and deployed independently, per the phased implementation plan.
//
// Flow: resolveActor (JWT) → requireEnterprise (private-beta gate) → build the
// shared TargetingEngine over the production Supabase gateway → rank() /
// targetAt() → JSON. Dependencies are injected so the handler is
// unit-testable without a live stack — same shape as geocontext/handler.ts.
import { corsHeaders } from "../_shared/cors.ts";
import { BadRequestError, errorResponse, json } from "../_shared/enterprise/errors.ts";
import { resolveActor as realResolveActor, type Actor } from "../_shared/enterprise/auth.ts";
import { serviceClient } from "../_shared/enterprise/clients.ts";
import { requireEnterprise as realRequireEnterprise } from "../_shared/enterprise/authz.ts";
import { makeServerGeoContext } from "../_shared/geocontext/serverGeoContext.ts";
import { cellFor, cellCentre, kRing, childrenOf } from "../_shared/geocontext/h3.ts";
import { fetchStructuralMapFeatures, fetchCommodityProfile, packWithMapFeatures } from "../_shared/geocontext/structuralPack.ts";
import {
  TargetingEngine, type TargetingResult, type H3Ops,
} from "../../../shared/geo-core/gie/targetingEngine.ts";
import {
  hotspotIn, type MissionHotspot, type HotspotH3Ops,
} from "../../../shared/geo-core/gie/hotspot.ts";

const DEFAULT_RADIUS_M = 25_000;
/**
 * Phase 15 (Geological Intelligence Transformation) — region-wide target
 * discovery reuses this SAME endpoint with a larger `rings`/`limit` (no new
 * engine, no new scoring): a manager scanning a wider region just asks for
 * more neighbours ranked instead of one target's immediate surroundings.
 *
 * MISSING UNTIL NOW: neither bound was enforced — a caller could request an
 * arbitrarily large `rings`, and k-ring cell count grows as 3r(r+1)+1
 * (~217 cells at r=8, ~1,261 at r=20), each cell needing its own GeoContext
 * fetch. `score-mission-cells` has carried an equivalent cap
 * (MAX_CELLS_PER_SCORING_CALL) since Phase 3; this was the one ranking path
 * that never got one. 8 rings (≈217 cells) keeps a single call inside the
 * same "a few seconds per cell" budget that cap was chosen for.
 */
export const MAX_RINGS = 8;
export const MAX_TARGETING_LIMIT = 50;
const H3_OPS: H3Ops = { cellFor, cellCentre, kRing };
const HOTSPOT_H3_OPS: HotspotH3Ops = { cellCentre, childrenOf };

export interface TeamTargetingResponse {
  current: { cell: string; score: number };
  targets: Array<{
    cell: string;
    centre: { lat: number; lng: number };
    bearingDeg: number;
    compass: string;
    distanceM: number;
    score: number;
    reportScore: number;
    band: string;
    reasons: unknown[];
    commodities: string[];
    scoredForCommodity: string | null;
  }>;
  bestIsHere: boolean;
  hotspot: MissionHotspot | null;
  /**
   * Honest about the gap (see prospectivityEvidence.ts / serverGeoContext.ts
   * header notes): structural/terrain/lithology-prior evidence needs a
   * server-side pack equivalent that does not exist yet. Occurrence,
   * association, community and geology-unit evidence ARE included.
   */
  evidenceCaveat: string;
}

export interface TeamTargetingDeps {
  resolveActor: (req: Request) => Promise<Actor>;
  requireEnterprise: (actor: Actor) => Promise<void>;
  buildEngine: (lat: number, lng: number, radiusM: number, commodity: string | null) => Promise<TargetingEngine>;
  findHotspot: (engine: TargetingEngine, cell: string, commodity: string | null) => Promise<MissionHotspot | null>;
}

export const defaultDeps: TeamTargetingDeps = {
  resolveActor: realResolveActor,
  requireEnterprise: (actor) => realRequireEnterprise(actor, serviceClient()),
  buildEngine: async (lat, lng, radiusM, commodity) => {
    const svc = serviceClient();
    const geo = makeServerGeoContext(svc);
    // Structural (fault) evidence — a minimal server-side pack carrying ONLY
    // fault/lineament geometry near this point (structuralPack.ts). No
    // `packOps`, so lithology/terrain priors (which need it) stay exactly as
    // unavailable as they are today; only the structural block activates.
    // No `local` either (no team-evidence source yet).
    // Real bug fix (2026-09-25): `commodity` used to reach here and then be
    // silently discarded — the pack always carried `commodities: []`, so
    // commodityModelFor() could never match it. Now fetched for real.
    const [mapFeatures, commodities] = await Promise.all([
      fetchStructuralMapFeatures(svc, lat, lng, radiusM),
      fetchCommodityProfile(svc, commodity),
    ]);
    return new TargetingEngine(geo, H3_OPS, undefined, () => packWithMapFeatures(mapFeatures, commodities));
  },
  findHotspot: (engine, cell, commodity) => {
    // hotspotIn needs a geo-context source and h3 ops; TargetingEngine does
    // not expose its own `geo`, so callers that want a hotspot build one the
    // same way `buildEngine` does. Kept as an injected dep so tests can stub
    // it without a live stack.
    const svc = serviceClient();
    const geo = makeServerGeoContext(svc);
    return hotspotIn(geo, HOTSPOT_H3_OPS, null, cell, { commodity });
  },
};

const EVIDENCE_CAVEAT =
  "Fault evidence (geo.structural_feature) IS included, fetched fresh per query " +
  "point. Contact, lithology-prior and terrain-prior evidence are not yet " +
  "available server-side (no contact data is loaded yet, and lithology/terrain " +
  "priors need a live equivalent of the mobile bundled pack's fitted statistics, " +
  "not built yet). Occurrence, association, community and geology-unit evidence " +
  "are included. Scores are directly comparable to Solo only where both evidence " +
  "sets happen to agree — see docs.";

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

export async function handleTeamTargeting(req: Request, deps: TeamTargetingDeps = defaultDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const actor = await deps.resolveActor(req);
    await deps.requireEnterprise(actor); // 403 unless enterprise-enabled

    let body: Record<string, unknown> = {};
    if (req.method === "POST") body = await req.json().catch(() => ({}));
    const url = new URL(req.url);
    const lat = num(body.lat ?? url.searchParams.get("lat"));
    const lng = num(body.lng ?? url.searchParams.get("lng"));
    if (lat === null || lng === null) throw new BadRequestError("lat and lng are required");
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new BadRequestError("lat/lng out of range");

    const radiusM = num(body.radiusM ?? url.searchParams.get("radiusM")) ?? DEFAULT_RADIUS_M;
    const commodity = (body.commodity ?? url.searchParams.get("commodity") ?? null) as string | null;
    const rawLimit = num(body.limit ?? url.searchParams.get("limit"));
    const rawRings = num(body.rings ?? url.searchParams.get("rings"));
    if (rawRings !== null && rawRings > MAX_RINGS) {
      throw new BadRequestError(`rings must be at most ${MAX_RINGS} (requested ${rawRings}) — scan a smaller region or in batches`);
    }
    const limit = rawLimit !== null ? Math.min(rawLimit, MAX_TARGETING_LIMIT) : undefined;
    const rings = rawRings ?? undefined;
    const wantHotspot = String(body.hotspot ?? url.searchParams.get("hotspot") ?? "") === "true";

    const engine = await deps.buildEngine(lat, lng, radiusM, commodity);
    const result: TargetingResult = await engine.rank(lat, lng, { radiusM, commodity, limit, rings });

    const best = result.targets[0] ?? null;
    let hotspot: MissionHotspot | null = null;
    if (wantHotspot && best) {
      hotspot = await deps.findHotspot(engine, best.cell, commodity);
    }

    const response: TeamTargetingResponse = {
      current: { cell: result.current.cell, score: result.current.score },
      targets: result.targets.map((t) => ({
        cell: t.cell, centre: t.centre, bearingDeg: t.bearingDeg, compass: t.compass,
        distanceM: t.distanceM, score: t.score, reportScore: t.reportScore, band: t.band,
        reasons: t.reasons, commodities: t.commodities, scoredForCommodity: t.scoredForCommodity,
      })),
      bestIsHere: result.bestIsHere,
      hotspot,
      evidenceCaveat: EVIDENCE_CAVEAT,
    };
    return json(response);
  } catch (err) {
    return errorResponse(err);
  }
}

// area-spectral-index — Phase 16 (Geological Intelligence Transformation),
// Remote-Sensing Spectral Intelligence, first real product: Iron Oxide Ratio
// (Sentinel-2 B04/B02) — a classic gossan/hydrothermal-alteration indicator
// that lines up directly with the "gossan"/"iron stain"/"hematite" language
// shared/geo-core already looks for in diagnosticObservations()
// (coreCommodityModel.ts). Computed server-side via the Copernicus Data
// Space Ecosystem (CDSE) Statistical API — OAuth client credentials
// (SENTINEL_HUB_CLIENT_ID/SECRET) live ONLY as Supabase Edge Function
// secrets; the mobile app never sees them or the CDSE access token.
//
// NOT wired into TargetingEngine/prospectivityEvidence: this value is
// informational, surfaced to a human via get_target_report's `spectral`
// section (0151). mission_assignment.prospectivity_score never reads
// enterprise.area_spectral_index (0150) — the deterministic scoring firewall
// this whole codebase enforces stays intact. Wiring this in as a scored (or
// even not_scored-but-engine-visible) EvidenceRole is deliberately deferred
// until this first product has been exercised against real field missions.
//
// QUOTA DISCIPLINE (one shared Copernicus account, ~30,000 PU+requests/month
// across everything this app does):
//   - AOI is a small FIXED footprint around the area's centre point
//     (AOI_HALF_WIDTH_M) — never the area's full drawn boundary, never a
//     region. A target is a point of interest, not a mapped polygon, for
//     this purpose.
//   - Exactly one evalscript, one index, 4 input bands (B02, B04, SCL,
//     dataMask) per call — see EVALSCRIPT.
//   - The Statistical API only bills PU for calendar days that actually had
//     an acquisition (confirmed empirically: a 60-day/P1D search over a real
//     point returned 12 dated intervals, not 60 empty ones).
//   - A cached row younger than CACHE_FRESHNESS_DAYS is returned with ZERO
//     calls to CDSE — repeat report views are free.
import { corsHeaders } from "../_shared/cors.ts";
import { BadRequestError, errorResponse, ForbiddenError, json, NotFoundError } from "../_shared/enterprise/errors.ts";
import { resolveActor as realResolveActor, type Actor } from "../_shared/enterprise/auth.ts";
import { serviceClient, userClient } from "../_shared/enterprise/clients.ts";

export const CACHE_FRESHNESS_DAYS = 14;
export const SEARCH_WINDOW_DAYS = 60;
export const AOI_HALF_WIDTH_M = 500; // → a 1km-square footprint around the target
export const INDEX_NAME = "iron_oxide_ratio";
export const RESOLUTION_M = 10;
export const SOURCE_LABEL = "Sentinel-2 L2A (Copernicus Data Space Ecosystem)";
const MAX_INPUT_CLOUD_COVERAGE = 60;

const TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token";
const STATS_URL = "https://sh.dataspace.copernicus.eu/api/v1/statistics";

// Issue 2 (2026-09-24 audit) — b04/b02 are read as INPUT bands already (to
// compute the ratio); this just also emits their own per-pixel values as two
// extra OUTPUT bands in the SAME single Statistics API call. No new input
// band, no second call, no AOI/quota change, cloud masking untouched.
export const EVALSCRIPT = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B02", "B04", "SCL", "dataMask"] }],
    output: [
      { id: "index", bands: 1, sampleType: "FLOAT32" },
      { id: "cloud", bands: 1, sampleType: "FLOAT32" },
      { id: "b04", bands: 1, sampleType: "FLOAT32" },
      { id: "b02", bands: 1, sampleType: "FLOAT32" },
    ],
  };
}
function evaluatePixel(s) {
  var cloud = (s.SCL === 8 || s.SCL === 9 || s.SCL === 10) ? 1 : 0;
  var idx = s.B02 > 0 ? s.B04 / s.B02 : 0;
  return { index: [idx], cloud: [cloud], b04: [s.B04], b02: [s.B02] };
}`;

const MERCATOR_R = 6_378_137;
export const lngToMercatorX = (lng: number): number => ((lng * Math.PI) / 180) * MERCATOR_R;
export const latToMercatorY = (lat: number): number =>
  Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * MERCATOR_R;

/** A small metres-wide square around (lat, lng), in WGS84 degrees. */
export function metreBufferToDegBbox(
  lat: number, lng: number, halfWidthM: number,
): [number, number, number, number] {
  const dLat = halfWidthM / 111_320;
  const dLng = halfWidthM / (111_320 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

export function degBboxToMercator(bbox: [number, number, number, number]): [number, number, number, number] {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  return [lngToMercatorX(minLng), latToMercatorY(minLat), lngToMercatorX(maxLng), latToMercatorY(maxLat)];
}

export interface SpectralRow {
  index_name: string;
  value: number | null;
  b04_mean: number | null;
  b02_mean: number | null;
  acquisition_date: string;
  cloud_fraction: number | null;
  valid_pixel_fraction: number | null;
  resolution_m: number;
  source: string;
  computed_at: string;
}

interface BestInterval {
  date: string;
  value: number;
  b04Mean: number | null;
  b02Mean: number | null;
  cloudFraction: number;
  validPixelFraction: number;
}

/** Picks the clearest (lowest cloud fraction) usable acquisition, not just
 *  the most recent — a cloud-contaminated ratio is worse than an older
 *  clear one (confirmed empirically: index mean swings from ~1.0 to ~2.1
 *  purely with cloud presence at a fixed point). Ties broken by recency. */
export function pickBestInterval(statsResponse: unknown): BestInterval | null {
  const data = (statsResponse as { data?: unknown[] })?.data;
  if (!Array.isArray(data)) return null;
  let best: BestInterval | null = null;
  for (const entry of data) {
    const e = entry as {
      interval?: { from?: string };
      outputs?: {
        index?: { bands?: { B0?: { stats?: { mean?: number; sampleCount?: number; noDataCount?: number } } } };
        cloud?: { bands?: { B0?: { stats?: { mean?: number } } } };
        b04?: { bands?: { B0?: { stats?: { mean?: number } } } };
        b02?: { bands?: { B0?: { stats?: { mean?: number } } } };
      };
    };
    const idxStats = e.outputs?.index?.bands?.B0?.stats;
    const cloudStats = e.outputs?.cloud?.bands?.B0?.stats;
    const b04Stats = e.outputs?.b04?.bands?.B0?.stats;
    const b02Stats = e.outputs?.b02?.bands?.B0?.stats;
    const date = e.interval?.from?.slice(0, 10);
    if (!idxStats || !date || typeof idxStats.sampleCount !== "number" || idxStats.sampleCount <= 0) continue;
    const noData = idxStats.noDataCount ?? 0;
    if (idxStats.sampleCount <= noData) continue;
    const candidate: BestInterval = {
      date,
      value: idxStats.mean ?? 0,
      b04Mean: b04Stats?.mean ?? null,
      b02Mean: b02Stats?.mean ?? null,
      cloudFraction: cloudStats?.mean ?? 1,
      validPixelFraction: (idxStats.sampleCount - noData) / idxStats.sampleCount,
    };
    if (!best || candidate.cloudFraction < best.cloudFraction
      || (candidate.cloudFraction === best.cloudFraction && candidate.date > best.date)) {
      best = candidate;
    }
  }
  return best;
}

export interface AreaLocation { lat: number; lng: number }

export interface SpectralDeps {
  resolveActor: (req: Request) => Promise<Actor>;
  isMissionMember: (req: Request, missionId: string) => Promise<boolean>;
  areaBelongsToMission: (missionId: string, areaId: string) => Promise<boolean>;
  fetchAreaLocation: (areaId: string) => Promise<AreaLocation | null>;
  fetchCached: (areaId: string) => Promise<SpectralRow | null>;
  fetchToken: () => Promise<string>;
  fetchStatistics: (bboxDeg: [number, number, number, number], from: string, to: string, token: string) => Promise<unknown>;
  persist: (
    missionId: string, areaId: string, row: Omit<SpectralRow, "computed_at">, computedBy: string, raw: unknown,
  ) => Promise<SpectralRow>;
  now: () => Date;
}

function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

// Module-scope token cache — CDSE tokens are short-lived (~10 min); reusing
// one across invocations of a warm isolate avoids burning a token request
// per report view.
let cachedToken: { token: string; expiresAt: number } | null = null;

async function realFetchToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 15_000) return cachedToken.token;
  const clientId = requireEnv("SENTINEL_HUB_CLIENT_ID");
  const clientSecret = requireEnv("SENTINEL_HUB_CLIENT_SECRET");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.access_token) {
    throw new Error(`Sentinel Hub OAuth failed: ${body?.error_description ?? body?.error ?? res.status}`);
  }
  cachedToken = { token: body.access_token, expiresAt: Date.now() + (Number(body.expires_in ?? 600) * 1000) };
  return cachedToken.token;
}

async function realFetchStatistics(
  bboxDeg: [number, number, number, number], from: string, to: string, token: string,
): Promise<unknown> {
  const bbox3857 = degBboxToMercator(bboxDeg);
  const body = {
    input: {
      bounds: { bbox: bbox3857, properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/3857" } },
      data: [{ type: "sentinel-2-l2a", dataFilter: { timeRange: { from, to }, maxCloudCoverage: MAX_INPUT_CLOUD_COVERAGE } }],
    },
    aggregation: {
      timeRange: { from, to },
      aggregationInterval: { of: "P1D" },
      evalscript: EVALSCRIPT,
      resx: RESOLUTION_M,
      resy: RESOLUTION_M,
    },
  };
  const res = await fetch(STATS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Sentinel Hub Statistics API failed (${res.status}): ${JSON.stringify(json).slice(0, 500)}`);
  return json;
}

export const defaultDeps: SpectralDeps = {
  resolveActor: realResolveActor,
  isMissionMember: async (req, missionId) => {
    const { data, error } = await userClient(req).rpc("is_mission_member", { p_mission: missionId });
    if (error) return false;
    return data === true;
  },
  areaBelongsToMission: async (missionId, areaId) => {
    const svc = serviceClient();
    const { data } = await svc.from("mission_area").select("area_id").eq("mission_id", missionId).eq("area_id", areaId).maybeSingle();
    return data != null;
  },
  fetchAreaLocation: async (areaId) => {
    const svc = serviceClient();
    const { data } = await svc.rpc("area_center_lat_lng", { p_area: areaId });
    if (!data) return null;
    const row = Array.isArray(data) ? data[0] : data;
    if (row?.lat == null || row?.lng == null) return null;
    return { lat: Number(row.lat), lng: Number(row.lng) };
  },
  fetchCached: async (areaId) => {
    const svc = serviceClient();
    const { data } = await svc
      .from("area_spectral_index")
      .select("index_name, value, b04_mean, b02_mean, acquisition_date, cloud_fraction, valid_pixel_fraction, resolution_m, source, computed_at")
      .eq("area_id", areaId)
      .eq("index_name", INDEX_NAME)
      .order("computed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data as SpectralRow | null) ?? null;
  },
  fetchToken: realFetchToken,
  fetchStatistics: realFetchStatistics,
  persist: async (missionId, areaId, row, computedBy, raw) => {
    const svc = serviceClient();
    const { data, error } = await svc
      .from("area_spectral_index")
      .upsert(
        { mission_id: missionId, area_id: areaId, ...row, computed_by: computedBy, raw },
        { onConflict: "area_id,index_name,acquisition_date" },
      )
      .select("index_name, value, b04_mean, b02_mean, acquisition_date, cloud_fraction, valid_pixel_fraction, resolution_m, source, computed_at")
      .single();
    if (error) throw new Error(`persisting spectral index: ${error.message}`);
    return data as SpectralRow;
  },
  now: () => new Date(),
};

export async function handleAreaSpectralIndex(req: Request, deps: SpectralDeps = defaultDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const actor = await deps.resolveActor(req);

    let body: Record<string, unknown> = {};
    if (req.method === "POST") body = await req.json().catch(() => ({}));
    const missionId = String(body.missionId ?? "");
    const areaId = String(body.areaId ?? "");
    if (!missionId || !areaId) throw new BadRequestError("missionId and areaId are required");

    if (!(await deps.isMissionMember(req, missionId))) {
      throw new ForbiddenError("only a member of this mission can compute a spectral index for its areas");
    }
    if (!(await deps.areaBelongsToMission(missionId, areaId))) {
      throw new NotFoundError("area not found in this mission");
    }

    const cached = await deps.fetchCached(areaId);
    const now = deps.now();
    const freshCutoff = new Date(now.getTime() - CACHE_FRESHNESS_DAYS * 86_400_000);
    if (cached && new Date(cached.computed_at) >= freshCutoff) {
      return json({ ...cached, cacheHit: true });
    }

    const location = await deps.fetchAreaLocation(areaId);
    if (!location) throw new NotFoundError("area has no location to analyze");

    const bboxDeg = metreBufferToDegBbox(location.lat, location.lng, AOI_HALF_WIDTH_M);
    const from = new Date(now.getTime() - SEARCH_WINDOW_DAYS * 86_400_000).toISOString();
    const to = now.toISOString();

    const token = await deps.fetchToken();
    const stats = await deps.fetchStatistics(bboxDeg, from, to, token);
    const best = pickBestInterval(stats);

    if (!best) {
      const row = await deps.persist(
        missionId, areaId,
        {
          index_name: INDEX_NAME, value: null, b04_mean: null, b02_mean: null, acquisition_date: to.slice(0, 10),
          cloud_fraction: null, valid_pixel_fraction: null, resolution_m: RESOLUTION_M, source: SOURCE_LABEL,
        },
        actor.userId, stats,
      );
      return json({
        ...row, cacheHit: false,
        note: `No cloud-free Sentinel-2 acquisition found in the last ${SEARCH_WINDOW_DAYS} days`,
      });
    }

    const row = await deps.persist(
      missionId, areaId,
      {
        index_name: INDEX_NAME, value: best.value, b04_mean: best.b04Mean, b02_mean: best.b02Mean, acquisition_date: best.date,
        cloud_fraction: best.cloudFraction, valid_pixel_fraction: best.validPixelFraction,
        resolution_m: RESOLUTION_M, source: SOURCE_LABEL,
      },
      actor.userId, stats,
    );
    return json({ ...row, cacheHit: false });
  } catch (err) {
    return errorResponse(err);
  }
}

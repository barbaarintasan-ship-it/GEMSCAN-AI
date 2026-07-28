// analyze-sample — the Geological Intelligence Engine endpoint (Sprint 4.3 S5).
//
// Orchestrates GATHER → VISION → REASON → SCORE/ASSEMBLE → PERSIST for one sample.
// Called server-to-server (service role) — auto-triggered in the background by
// enterprise-samples after a submit, or invokable manually to re-run. Idempotent
// per (sample, input_hash); auto-run is bounded by a daily cap. All stages are
// injected so the orchestration is unit-testable without a DB or the Gemini key.
import { errorResponse, json, BadRequestError, NotFoundError, UnauthorizedError } from "../_shared/enterprise/errors.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/enterprise/clients.ts";
import { cellFor } from "../_shared/geocontext/h3.ts";
import { buildProviders } from "../_shared/geocontext/providers/index.ts";
import { makeSupabaseGateway } from "../_shared/geocontext/providers/supabaseGateway.ts";
import { assemble, fieldEvidence, geoEvidence, runProviders } from "../_shared/gie/gather.ts";
import { defaultVisionDeps, runVision, visualEvidence, type VisualObservation } from "../_shared/gie/vision.ts";
import { defaultReasoningDeps, runReasoning, type ReasoningOutput } from "../_shared/gie/reasoning.ts";
import { assembleAssessment } from "../_shared/gie/assemble.ts";
import type { SampleInput } from "../_shared/gie/types.ts";
import type { GeoQuery, ProviderContribution } from "../_shared/geocontext/types.ts";

export const ENGINE_VERSION = "gie-1.0.0";
const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest";
const RADIUS_M = 25000;
const DAILY_CAP = Number(Deno.env.get("GIE_DAILY_CAP") ?? "200");

export interface LoadedSample {
  sample: SampleInput;
  actorId: string;
  imageUrls: string[];
  imageQuality: number; // 0..1
  inputHash: string;
}

export interface AnalyzeDeps {
  authorize: (req: Request) => void;
  loadSample: (id: string) => Promise<LoadedSample | null>;
  runProviders: (q: GeoQuery) => Promise<{ contributions: ProviderContribution[]; providersRun: string[]; providersFailed: string[] }>;
  runVision: (imageUrls: string[]) => Promise<VisualObservation[]>;
  runReasoning: (nodes: Parameters<typeof runReasoning>[0], summary: string) => Promise<ReasoningOutput>;
  saveAssessment: (sampleId: string, actorId: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  countToday: () => Promise<number>;
  dailyCap: number;
}

export function sampleSummary(s: SampleInput): string {
  const parts: string[] = [];
  if (s.hostRock?.rockClass) parts.push(`host rock ${s.hostRock.rockClass}`);
  if (s.minerals.length) parts.push(`minerals ${s.minerals.map((m) => m.mineral).join(", ")}`);
  if (s.alteration?.alterationType) parts.push(`alteration ${s.alteration.alterationType}`);
  if (s.structural.length) parts.push(`structures ${s.structural.map((x) => x.structureType).filter(Boolean).join(", ")}`);
  if (s.geologicalEnvironment) parts.push(`environment ${s.geologicalEnvironment}`);
  return parts.join("; ") || "field sample";
}

export async function handleAnalyze(req: Request, deps: AnalyzeDeps = defaultDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    deps.authorize(req);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const sampleId = typeof body.sample_id === "string" ? body.sample_id : "";
    if (!sampleId) throw new BadRequestError("sample_id is required");
    // force = an explicit re-analysis (owner or geologist). It re-gathers evidence
    // fresh (picking up any newly loaded data), bypasses the per-day auto-run cap,
    // and writes a NEW assessment instead of reusing the idempotent one.
    const force = body.force === true;

    // Cost guard: only the automatic post-submit run is bounded per day.
    if (!force && (await deps.countToday()) >= deps.dailyCap) {
      return json({ skipped: "daily_cap", cap: deps.dailyCap }, 200);
    }

    const loaded = await deps.loadSample(sampleId);
    if (!loaded) throw new NotFoundError("sample not found");
    const { sample } = loaded;

    // GATHER (geo) + VISION → unified Evidence Set (visual folded in before ids)
    const query: GeoQuery = { lat: sample.lat, lng: sample.lng, radiusM: RADIUS_M, h3: cellFor(sample.lat, sample.lng) };
    const { contributions, providersRun, providersFailed } = await deps.runProviders(query);
    const visualObs = await deps.runVision(loaded.imageUrls);
    const set = assemble(
      [...fieldEvidence(sample), ...geoEvidence(contributions), ...visualEvidence(visualObs, loaded.imageQuality)],
      providersRun, providersFailed,
    );

    // REASON → SCORE/ASSEMBLE
    const reasoning = await deps.runReasoning(set.nodes, sampleSummary(sample));
    const assessment = assembleAssessment(set, reasoning);

    // PERSIST
    // A forced re-run gets a unique hash so it writes a fresh assessment (history
    // preserved) instead of returning the idempotent one.
    const inputHash = force ? `${loaded.inputHash}-${Date.now()}` : loaded.inputHash;
    const result = await deps.saveAssessment(sampleId, loaded.actorId, {
      ...assessment, engineVersion: ENGINE_VERSION, model: MODEL, inputHash,
    });

    return json({
      assessment_id: result.assessment_id ?? null,
      overall_confidence: assessment.overallConfidence,
      conclusions: assessment.conclusions.length,
      evidence: set.nodes.length,
      dropped_conclusions: assessment.droppedConclusions,
      providers_run: providersRun,
      providers_failed: providersFailed,
      idempotent: result.idempotent ?? false,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// ── Default deps (real DB + Gemini) ─────────────────────────────────────────
function startOfTodayISO(): string {
  const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.toISOString();
}

async function hashInputs(sampleId: string, updatedAt: string | null, mediaPaths: string[]): Promise<string> {
  const data = new TextEncoder().encode(`${sampleId}|${updatedAt ?? ""}|${mediaPaths.sort().join(",")}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export const defaultDeps: AnalyzeDeps = {
  dailyCap: DAILY_CAP,
  authorize: (req) => {
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const auth = req.headers.get("Authorization") ?? "";
    if (!key || auth !== `Bearer ${key}`) throw new UnauthorizedError("service authorization required");
  },
  countToday: async () => {
    const { count } = await serviceClient("geo").from("geological_assessment")
      .select("id", { count: "exact", head: true }).gte("created_at", startOfTodayISO());
    return count ?? 0;
  },
  loadSample: async (id) => {
    const svc = serviceClient(); // enterprise schema
    const { data: sRow } = await svc.from("sample")
      .select("id,collector_id,collected_at,updated_at,terrain_type,geological_environment,field_observations," +
        "sample_location(altitude_m,gps_accuracy_m)," +
        "sample_media(storage_path,image_quality_score)," +
        "rock_observation(rock_class,texture,weathering,notes)," +
        "mineral_observation(mineral,confidence)," +
        "alteration_observation(alteration_type,intensity,notes)," +
        "structural_measurement(structure_type,strike_deg,dip_deg,dip_direction)")
      .eq("id", id).is("deleted_at", null).maybeSingle();
    if (!sRow) return null;
    // deno-lint-ignore no-explicit-any -- DB glue reading a known nested shape
    const s = sRow as any;

    // Coordinates come from the PostGIS point via a small RPC (lat/lng not stored as columns).
    const { data: coord } = await serviceClient("geo").rpc("sample_coords", { p_sample: id });
    const lat = Number((coord as { lat?: number })?.lat ?? 0);
    const lng = Number((coord as { lng?: number })?.lng ?? 0);

    const media = (s.sample_media ?? []) as Array<{ storage_path: string; image_quality_score: number | null }>;
    const paths = media.map((m) => m.storage_path);
    const imageUrls: string[] = [];
    for (const p of paths) {
      const { data: signed } = await svc.storage.from("scan-images").createSignedUrl(p, 600);
      if (signed?.signedUrl) imageUrls.push(signed.signedUrl);
    }
    const iqs = media.map((m) => m.image_quality_score).filter((n): n is number => n != null);
    const imageQuality = iqs.length ? Math.max(0, Math.min(1, (iqs.reduce((a, b) => a + b, 0) / iqs.length) / 100)) : 0.8;

    const loc = (s.sample_location?.[0] ?? {}) as { altitude_m?: number | null; gps_accuracy_m?: number | null };
    const rock = (s.rock_observation?.[0] ?? null) as SampleInput["hostRock"];
    const alt = (s.alteration_observation?.[0] ?? null) as { alteration_type?: string | null; intensity?: string | null; notes?: string | null } | null;

    const sample: SampleInput = {
      id: s.id, name: null, lat, lng,
      altitudeM: loc.altitude_m ?? null, gpsAccuracyM: loc.gps_accuracy_m ?? null,
      collectedAt: s.collected_at, terrainType: s.terrain_type, geologicalEnvironment: s.geological_environment,
      fieldObservations: s.field_observations,
      hostRock: rock ? { rockClass: (rock as { rock_class?: string }).rock_class ?? null, texture: (rock as { texture?: string }).texture ?? null, weathering: (rock as { weathering?: string }).weathering ?? null, notes: (rock as { notes?: string }).notes ?? null } : null,
      minerals: ((s.mineral_observation ?? []) as Array<{ mineral: string; confidence: number | null }>).map((m) => ({ mineral: m.mineral, confidence: m.confidence })),
      alteration: alt ? { alterationType: alt.alteration_type ?? null, intensity: alt.intensity ?? null, notes: alt.notes ?? null } : null,
      structural: ((s.structural_measurement ?? []) as Array<{ structure_type: string | null; strike_deg: number | null; dip_deg: number | null; dip_direction: number | null }>)
        .map((x) => ({ structureType: x.structure_type, strikeDeg: x.strike_deg, dipDeg: x.dip_deg, dipDirection: x.dip_direction })),
    };

    return { sample, actorId: (s.collector_id as string) ?? id, imageUrls, imageQuality, inputHash: await hashInputs(id, s.updated_at, paths) };
  },
  runProviders: (q) => runProviders(buildProviders(makeSupabaseGateway(serviceClient())), q),
  runVision: (urls) => runVision(urls, defaultVisionDeps),
  runReasoning: (nodes, summary) => runReasoning(nodes, summary, defaultReasoningDeps),
  saveAssessment: async (sampleId, actorId, payload) => {
    const { data, error } = await serviceClient("geo").rpc("save_assessment", { p_sample: sampleId, p_actor: actorId, p_payload: payload });
    if (error) throw new Error(`save_assessment: ${error.message}`);
    return (data ?? {}) as Record<string, unknown>;
  },
};

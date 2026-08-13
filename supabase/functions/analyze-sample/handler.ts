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
import { buildKnowledgeProviders, buildProviders } from "../_shared/geocontext/providers/index.ts";
import { makeSupabaseGateway } from "../_shared/geocontext/providers/supabaseGateway.ts";
import { assemble, fieldEvidence, geoEvidence, runProviders } from "../_shared/gie/gather.ts";
import { defaultVisionDeps, runVision, visualEvidence, type VisualObservation } from "../_shared/gie/vision.ts";
import { defaultReasoningDeps, runReasoning, type ReasoningOutput } from "../_shared/gie/reasoning.ts";
import { assembleAssessment } from "../_shared/gie/assemble.ts";
import type { SampleInput } from "../_shared/gie/types.ts";
import type { GeoQuery, ProviderContribution } from "../_shared/geocontext/types.ts";
import { withDeadline, BUDGET_MS } from "../_shared/timeout.ts";

export const ENGINE_VERSION = "gie-1.0.0";
const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest";
const RADIUS_M = 25000;
const DAILY_CAP = Number(Deno.env.get("GIE_DAILY_CAP") ?? "200");

/**
 * Which workflow this sample belongs to, and therefore what may be inferred.
 *
 * `personal` — a collected specimen. Visual identification and mineral knowledge
 * only. No spatial inference: no mapped geology, no nearby occurrences, no
 * structural context, no community reports, and therefore nothing resembling a
 * prospectivity statement about where it was picked up.
 *
 * `exploration` — evidence of a field mission. The full engine, because the whole
 * question being asked IS about the ground.
 */
export type SampleLane = "personal" | "exploration";

export interface LoadedSample {
  sample: SampleInput;
  actorId: string;
  imageUrls: string[];
  imageQuality: number; // 0..1
  inputHash: string;
  /** Absent on rows written before 0102 — those are all personal. */
  lane: SampleLane;
}

export interface AnalyzeDeps {
  authorize: (req: Request) => void;
  loadSample: (id: string) => Promise<LoadedSample | null>;
  /**
   * Gather evidence. The LANE decides which providers are even constructed —
   * see buildKnowledgeProviders in _shared/geocontext/providers/index.ts.
   */
  runProviders: (q: GeoQuery, lane: SampleLane) => Promise<{ contributions: ProviderContribution[]; providersRun: string[]; providersFailed: string[] }>;
  runVision: (imageUrls: string[]) => Promise<VisualObservation[]>;
  runReasoning: (nodes: Parameters<typeof runReasoning>[0], summary: string) => Promise<ReasoningOutput>;
  saveAssessment: (sampleId: string, actorId: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Records that a run has begun, so a died run is distinguishable from one never triggered. */
  markStarted: (sampleId: string) => Promise<void>;
  /** Records why a run failed, so the collector is told instead of left waiting. */
  markFailed: (sampleId: string, reason: string) => Promise<void>;
  countToday: () => Promise<number>;
  dailyCap: number;
  /**
   * Stage budgets, injected like every other stage here.
   *
   * Optional so no existing caller changes. Present so a hang — the failure that
   * stranded twelve samples — can be exercised in milliseconds instead of by
   * waiting out a real fifty-second budget in the test suite.
   */
  budgets?: { visionStage?: number; reasoningStage?: number };
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
  // Declared outside the try so the catch can tell "never started" from "started
  // and died" — the distinction migration 0092 exists to preserve.
  let started = false;
  let sampleId = "";
  // Set by whichever stage records first. The backstop must not overwrite a
  // specific diagnosis ("Evidence gathering failed: …") with a generic one.
  let reasonRecorded = false;
  const recordFailure = async (reason: string) => {
    reasonRecorded = true;
    await deps.markFailed(sampleId, reason).catch(() => {});
  };
  try {
    deps.authorize(req);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    sampleId = typeof body.sample_id === "string" ? body.sample_id : "";
    if (!sampleId) throw new BadRequestError("sample_id is required");
    // force = an explicit re-analysis (owner or geologist). It re-gathers evidence
    // fresh (picking up any newly loaded data), bypasses the per-day auto-run cap,
    // and writes a NEW assessment instead of reusing the idempotent one.
    const force = body.force === true;

    // Cost guard: only the automatic post-submit run is bounded per day.
    if (!force && (await deps.countToday()) >= deps.dailyCap) {
      // Recorded, not just returned. This branch used to answer 200 and leave
      // the sample at "submitted" forever with the reason known only to a log
      // nobody reads.
      await deps.markFailed(
        sampleId,
        `Daily analysis limit reached (${deps.dailyCap}). Try again tomorrow, or ask for a re-analysis.`,
      ).catch(() => {});
      return json({ skipped: "daily_cap", cap: deps.dailyCap }, 200);
    }

    const loaded = await deps.loadSample(sampleId);
    if (!loaded) throw new NotFoundError("sample not found");
    const { sample } = loaded;

    // From here on the sample is IN a run, and every exit path below records
    // its outcome. Before this line a failure means the sample was never really
    // started; after it, the reason is written to the row.
    await deps.markStarted(sampleId);
    // ...and this is what makes that sentence true rather than aspirational. The
    // claim was made in this comment and enforced only at the three call sites
    // someone had thought of; anything else threw straight past it. The flag lets
    // the outer catch close every remaining path, including the ones added later.
    started = true;

    // GATHER (geo) + VISION → unified Evidence Set (visual folded in before ids)
    const query: GeoQuery = {
      lat: sample.lat, lng: sample.lng, radiusM: RADIUS_M, h3: cellFor(sample.lat, sample.lng),
      // EMIE: give the knowledge providers the sample's own field observations so
      // they can key off the actual host rock / minerals / alteration / structure.
      sample: {
        hostRocks: sample.hostRock?.rockClass ? [sample.hostRock.rockClass] : [],
        minerals: sample.minerals.map((m) => m.mineral).filter(Boolean),
        alteration: sample.alteration?.alterationType ? [sample.alteration.alterationType] : [],
        structures: sample.structural.map((s) => s.structureType).filter((x): x is string => !!x),
      },
    };
    // GATHER can strand a sample, and it did.
    //
    // This call sits AFTER markStarted and had no guard, while reasoning and
    // persist below each had one. So a throw here — a geo query, a knowledge
    // provider, anything under runProviders — fell through to the outer catch,
    // which returned an HTTP error to a caller that was ignoring it and wrote
    // NOTHING to the row. The sample kept ai_processing for ever with no reason
    // recorded: nine of them, overnight, which is the report that found this.
    //
    // Gathering failing is also a different diagnosis from reasoning failing, so
    // it says so rather than being folded into a generic message.
    let contributions, providersRun, providersFailed;
    try {
      ({ contributions, providersRun, providersFailed } = await deps.runProviders(query, loaded.lane));
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`analyze-sample ${sampleId}: evidence gathering failed —`, reason);
      await recordFailure(`Evidence gathering failed: ${reason}`);
      throw e;
    }
    // Vision is ENRICHMENT, not a precondition. A failure here (oversized
    // payload, a dead signed URL, a model hiccup) used to reject the whole run,
    // leaving the sample at "submitted" with no assessment and no explanation.
    // The geological providers alone still yield a real assessment, so a vision
    // failure degrades the result rather than discarding it — the same rule the
    // GeoContext engine already applies to a failing provider.
    let visualObs: VisualObservation[] = [];
    try {
      // Bounded as a WHOLE, not just per call: the cost of this stage scales
      // with the number of photographs, and that is the variable that was
      // killing runs. Vision is enrichment, so a timeout here degrades the
      // result rather than failing the sample — the existing policy, now
      // reachable, because a hang never used to reach this catch at all.
      visualObs = await withDeadline(
        deps.runVision(loaded.imageUrls),
        deps.budgets?.visionStage ?? BUDGET_MS.visionStage,
        "Image analysis",
      );
    } catch (e) {
      console.error(`analyze-sample ${sampleId}: vision failed, continuing without it —`, e);
    }
    const set = assemble(
      [...fieldEvidence(sample), ...geoEvidence(contributions), ...visualEvidence(visualObs, loaded.imageQuality)],
      providersRun, providersFailed,
    );

    // REASON → SCORE/ASSEMBLE
    // Unlike vision, reasoning cannot be skipped — it IS the assessment, and a
    // report assembled without it would be an empty one presented as a result.
    // So a failure here is RECORDED against the sample and re-thrown, rather
    // than propagating as a bare 500 that leaves the row at "submitted". This
    // was the gap: the earlier fix made vision resilient and left reasoning
    // able to strand a sample on any Gemini hiccup.
    let reasoning: ReasoningOutput;
    try {
      reasoning = await withDeadline(
        deps.runReasoning(set.nodes, sampleSummary(sample)),
        deps.budgets?.reasoningStage ?? BUDGET_MS.reasoningStage,
        "Geological reasoning",
      );
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`analyze-sample ${sampleId}: reasoning failed —`, reason);
      await recordFailure(`Geological reasoning failed: ${reason}`);
      throw e;
    }
    const assessment = assembleAssessment(set, reasoning);

    // PERSIST
    // A forced re-run gets a unique hash so it writes a fresh assessment (history
    // preserved) instead of returning the idempotent one.
    const inputHash = force ? `${loaded.inputHash}-${Date.now()}` : loaded.inputHash;
    let result: Record<string, unknown>;
    try {
      result = await deps.saveAssessment(sampleId, loaded.actorId, {
        ...assessment, engineVersion: ENGINE_VERSION, model: MODEL, inputHash,
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`analyze-sample ${sampleId}: persist failed —`, reason);
      await recordFailure(`Could not save the assessment: ${reason}`);
      throw e;
    }

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
    // THE BACKSTOP. A run that had started must never end without saying why.
    //
    // Every stage above records its own, more specific reason first; markFailed
    // is idempotent in effect (last write wins on the same row) so a second call
    // here is harmless. What matters is the path nobody anticipated — a throw in
    // assemble, in cellFor, in a stage added next year — which previously
    // returned an HTTP error to a fire-and-forget caller that discarded it, and
    // left the row at ai_processing with nothing recorded anywhere.
    //
    // This cannot catch the isolate being KILLED (no code runs then). That case
    // is a genuinely stalled row, which the client now names by the age of
    // ai_attempted_at — see mobile/lib/samples/sampleStatus.
    if (started && sampleId && !reasonRecorded) {
      const reason = err instanceof Error ? err.message : String(err);
      await deps.markFailed(sampleId, `Analysis failed: ${reason}`).catch(() => {});
    }
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
      .select("id,collector_id,collected_at,updated_at,terrain_type,geological_environment,field_observations,origin," +
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

    // Highest-quality images first: runVision caps the count, so ordering decides
    // WHICH photos the model actually sees. Unscored media sorts last rather than
    // being dropped — a missing score is not evidence of a bad photo.
    const media = ([...(s.sample_media ?? [])] as Array<{ storage_path: string; image_quality_score: number | null }>)
      .sort((a, b) => (b.image_quality_score ?? -1) - (a.image_quality_score ?? -1));
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

    // Anything that is not explicitly 'exploration' is personal. Rows written
    // before 0102 carry no origin at all, and those are all personal — but the
    // rule is stated as a positive test rather than a default so a typo, a new
    // enum value or a dropped column can only ever narrow what may be inferred,
    // never widen it.
    const lane: SampleLane = s.origin === "exploration" ? "exploration" : "personal";

    return {
      sample, actorId: (s.collector_id as string) ?? id, imageUrls, imageQuality,
      lane, inputHash: await hashInputs(id, s.updated_at, paths),
    };
  },
  runProviders: (q, lane) => runProviders(
    // THE LANE SPLIT. A personal sample never meets a spatial provider.
    (lane === "personal" ? buildKnowledgeProviders : buildProviders)(
      makeSupabaseGateway(serviceClient()),
    ),
    q,
  ),
  runVision: (urls) => runVision(urls, defaultVisionDeps),
  runReasoning: (nodes, summary) => runReasoning(nodes, summary, defaultReasoningDeps),
  markStarted: async (sampleId) => {
    const { error } = await serviceClient("geo").rpc("mark_analysis_started", { p_sample: sampleId });
    // Never fatal: failing to record progress must not prevent the analysis the
    // recording is about.
    if (error) console.error(`mark_analysis_started ${sampleId}: ${error.message}`);
  },
  markFailed: async (sampleId, reason) => {
    const { error } = await serviceClient("geo").rpc("mark_analysis_failed", { p_sample: sampleId, p_reason: reason });
    if (error) console.error(`mark_analysis_failed ${sampleId}: ${error.message}`);
  },
  saveAssessment: async (sampleId, actorId, payload) => {
    const { data, error } = await serviceClient("geo").rpc("save_assessment", { p_sample: sampleId, p_actor: actorId, p_payload: payload });
    if (error) throw new Error(`save_assessment: ${error.message}`);
    return (data ?? {}) as Record<string, unknown>;
  },
};

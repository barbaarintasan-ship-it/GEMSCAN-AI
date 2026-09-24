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
import { serviceClient, userClient, type DbClient } from "../_shared/enterprise/clients.ts";
import { requireEnterprise as realRequireEnterprise, requirePersonalSampleAccess as realRequirePersonalSampleAccess } from "../_shared/enterprise/authz.ts";
import { cellFor, H3_RESOLUTION } from "../_shared/geocontext/h3.ts";

const MEDIA_ROLES = ["context", "surface_closeup", "texture_structure", "key_feature", "scale_reference", "extra"];
const CLOSEUP_ROLES = ["surface_closeup", "texture_structure", "key_feature"]; // count as a "specimen close-up"
const GPS_SOURCES = ["gps", "fused", "network", "manual"];
const LOCATION_ORIGINS = ["observed", "reported"];
// Phase 6 — mirrors enterprise.structured_evidence_type (0128) and Solo's own
// StructuredGeologicalEvidence section names (structuredEvidenceTypes.ts).
const STRUCTURED_EVIDENCE_TYPES = ["assay", "geophysics", "mapping", "remote_sensing", "field_observation"];
const H3_RES = 9; // ~174 m cells for sample points
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 500;
// Mission-assignment resolution (Phase 2B/2C) — the SAME shared H3_RESOLUTION
// mission_assignment.target_h3 is generated at, deliberately coarser than the
// sample's own H3_RES=9 point cell. Two different questions: "exactly where
// is this rock" (9) vs "whose work-allocation cell is this rock inside" (7).
const LIST_COLS = "id,name,collected_at,status,completeness_status,completeness_score," +
  "ai_confidence,geologist_confidence,confidence_score,area_id,created_at,origin";
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
  requirePersonalSampleAccess: (actor: Actor) => Promise<void>;
  createSample: (actor: Actor, payload: Record<string, unknown>) => Promise<unknown>;
  editSample: (actor: Actor, id: string, payload: Record<string, unknown>) => Promise<unknown>;
  listSamples: (req: Request, actor: Actor, origin?: string, page?: { limit: number; offset: number }) => Promise<unknown>;
  getSample: (req: Request, actor: Actor, id: string) => Promise<unknown | null>;
  reanalyze: (actor: Actor, id: string) => Promise<void>;
  deleteSample: (actor: Actor, id: string) => Promise<void>;
}

export const defaultDeps: Deps = {
  resolveActor: realResolveActor,
  requireEnterprise: (a) => realRequireEnterprise(a, serviceClient()),
  requirePersonalSampleAccess: (a) => realRequirePersonalSampleAccess(a, serviceClient()),
  createSample: async (actor, payload) => {
    const svc = serviceClient();

    /**
     * IDEMPOTENT when the device supplies its own id (0096).
     *
     * A field submission carries megabytes of photographs over a link that
     * routinely dies mid-request, so the device cannot know whether the record
     * arrived, and retries. Without this, that is how the same outcrop ends up in
     * the collection four times — each with its own analysis, each costing an
     * inference.
     *
     * Look first, insert second, then claim the id. The claim is what closes the
     * race: if two retries arrive together, the unique index rejects the second,
     * and `claim_sample_client_id` returns the winner and soft-deletes the loser.
     * Callers that send no id behave exactly as before.
     */
    const clientLocalId = typeof payload.client_local_id === "string" && payload.client_local_id.length > 0
      ? payload.client_local_id.slice(0, 120)
      : null;

    if (clientLocalId) {
      const { data: existing } = await svc.rpc("find_sample_by_client_id", {
        p_actor: actor.userId,
        p_client_local_id: clientLocalId,
      });
      if (existing) {
        // Already filed. Return it unchanged — and do NOT re-run the analysis,
        // which is the expensive half of accepting a duplicate.
        const { data: detail } = await svc.from("sample").select(DETAIL).eq("id", existing).maybeSingle();
        return { sample_id: existing as string, sample: detail, deduplicated: true };
      }
    }

    // submit_sample validates its own payload and does not know these columns.
    const { client_local_id: _unused, scan_id: scanId, ...submitPayload } = payload as Record<string, unknown>;

    // SCAN → SAMPLE bridge: reuse the scan's photographs instead of making the
    // user re-shoot the same rock. The scan's images already live in the
    // shared `scan-images` bucket; we COPY them to fresh, sample-owned paths so
    // the sample owns its media outright — deleting a sample can never disturb
    // the scan it came from. Only runs when the client sent a scanId and no media.
    if (typeof scanId === "string" && scanId && !Array.isArray(submitPayload.media)) {
      submitPayload.media = await copyScanMediaForActor(svc, actor.userId, scanId);
    }

    const { data, error } = await svc.rpc("submit_sample", { p_actor: actor.userId, p_payload: submitPayload });
    // The RPC raises 'validation: …' for a bad request — surface that as a 400.
    if (error) {
      if (/validation:/i.test(error.message)) throw new BadRequestError(error.message.replace(/^.*validation:\s*/i, ""));
      throw new Error(`submit_sample: ${error.message}`);
    }
    let id = (data as { sample_id: string }).sample_id;

    if (clientLocalId) {
      const { data: claimed, error: claimError } = await svc.rpc("claim_sample_client_id", {
        p_actor: actor.userId,
        p_sample: id,
        p_client_local_id: clientLocalId,
      });
      // A failed claim leaves the sample filed but unkeyed: better a sample the
      // device may re-send than a sample nobody has.
      if (!claimError && typeof claimed === "string") id = claimed;
    }

    triggerAnalysis(id); // auto-run the Geological Intelligence Engine (non-blocking, §6)
    const { data: detail } = await svc.from("sample").select(DETAIL).eq("id", id).maybeSingle();
    return { ...(data as object), sample_id: id, sample: detail };
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
  listSamples: async (req, actor, origin, page = { limit: DEFAULT_LIST_LIMIT, offset: 0 }) => {
    let q = userClient(req).from("sample")
      .select(LIST_COLS)
      .eq("collector_id", actor.userId).is("deleted_at", null);
    // My Samples asks for `personal` and gets ONLY personal. Filtered in the
    // query rather than on the device: a screen that fetched both and hid one
    // would still have downloaded a mission's evidence into a personal
    // collection, and the next person to add a list would forget the hiding.
    if (origin) q = q.eq("origin", origin);
    // A prolific field collector's samples grow unbounded over time — this
    // table has no natural ceiling. Paginated (newest first) rather than
    // returned in full every call.
    const { data, error } = await q
      .order("created_at", { ascending: false })
      .range(page.offset, page.offset + page.limit - 1);
    if (error) throw new Error(`list: ${error.message}`);
    return data ?? [];
  },
  // AWAITED, unlike the auto-run on create. Someone pressed a button and is
  // watching the screen; "started" has to mean started. A dispatch that failed
  // is recorded on the sample AND thrown, so the app shows the real reason
  // instead of "refresh in a moment" over an analysis that was never sent.
  reanalyze: async (_actor, id) => {
    const failure = await dispatchAnalysis(id, true);
    if (failure) {
      await recordDispatchFailure(id, failure.reason);
      throw new Error(`re-analysis could not be started: ${failure.reason}`);
    }
  },
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
    // Assessment/review/discussion each depend only on `id` (already known),
    // not on `data` or on each other — run concurrently instead of one round
    // trip at a time.
    const [{ data: assessment }, { data: review }, { data: discussion }] = await Promise.all([
      // Latest geological assessment (RLS: can_read_assessment) + its evidence graph.
      userClient(req, "geo").from("geological_assessment")
        .select("id,overall_confidence,status,report,created_at," +
          "assessment_conclusion(id,kind,statement,statement_so,is_interpretation,confidence)," +
          "assessment_evidence(id,source,ev_type,statement,statement_so,is_observation,tier,quality)," +
          "assessment_edge(conclusion_id,evidence_id,polarity,contribution,effective_weight)")
        .eq("sample_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      // Geologist's latest binding review, so the collector actually SEES the
      // reviewer's decision, confidence, notes (RLS: can_read_sample lets the
      // collector read their own sample's review/discussion).
      uc.from("sample_review")
        .select("id,round_no,status,decision,geologist_confidence,corrected_interpretation,review_notes,recommendation,reviewer_role,submitted_at")
        .eq("sample_id", id).eq("status", "submitted").order("round_no", { ascending: false }).limit(1).maybeSingle(),
      // ...and the discussion timeline.
      uc.from("sample_discussion")
        .select("id,author_role,body,created_at").eq("sample_id", id).order("created_at", { ascending: true }),
    ]);
    return { ...(data as object), assessment: assessment ?? null, review: review ?? null, discussion: discussion ?? [] };
  },
};

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

/** Why a dispatch never happened. Null when analyze-sample was reached. */
type DispatchFailure = { reason: string } | null;

/**
 * Send one sample to analyze-sample, and REPORT whether the send got through.
 *
 * WHAT WENT WRONG BEFORE. This returned `void`. A missing SUPABASE_URL or
 * SERVICE_ROLE_KEY returned early with no log at all, and a fetch rejection was
 * logged and dropped. `reanalyze` then answered 200 unconditionally, so the app
 * told a geologist "Re-analysis started · refresh in a moment" when nothing had
 * been dispatched — a claim the server had no basis for. They pressed it, waited,
 * refreshed, and the collection was unchanged, because there had never been
 * anything to wait for.
 *
 * Distinguish the two callers, because they want opposite things:
 *
 *   ON CREATE  a human is waiting for the SUBMIT to return, not for an analysis.
 *              Non-blocking is right — but a dispatch that cannot happen is now
 *              written to the sample, so the row says why instead of sitting at
 *              a status nothing will ever move.
 *
 *   ON RETRY   a human pressed "re-analyse" and is watching. The outcome of the
 *              dispatch is the answer to their question, so it is awaited and
 *              returned.
 */
async function dispatchAnalysis(sampleId: string, force: boolean): Promise<DispatchFailure> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  // A configuration fault, not a transient one. Silence here is what made the
  // engine look like it was running when it could not even be called.
  if (!url || !key) {
    const reason = "analysis is not configured on the server (SUPABASE_URL or SERVICE_ROLE_KEY missing)";
    console.error(`analyze-sample ${sampleId} -> NOT DISPATCHED: ${reason}`);
    return { reason };
  }
  try {
    const res = await fetch(`${url}/functions/v1/analyze-sample`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ sample_id: sampleId, force }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const reason = `analyze-sample returned HTTP ${res.status}: ${body.slice(0, 300)}`;
      console.error(`analyze-sample ${sampleId} -> ${reason}`);
      return { reason };
    }
    return null;
  } catch (e) {
    const reason = `could not reach analyze-sample: ${e instanceof Error ? e.message : String(e)}`;
    console.error(`analyze-sample ${sampleId} -> ${reason}`);
    return { reason };
  }
}

/**
 * Record against the SAMPLE that its analysis could not even be started.
 *
 * Without this a failed dispatch left the row at whatever status it had, with no
 * error and nothing to retry from — indistinguishable from an analysis quietly
 * in progress. That ambiguity is the entire defect being closed here.
 */
async function recordDispatchFailure(sampleId: string, reason: string): Promise<void> {
  try {
    await serviceClient("geo").rpc("mark_analysis_failed", { p_sample: sampleId, p_reason: reason });
  } catch (e) {
    console.error(`mark_analysis_failed ${sampleId}:`, e);
  }
}

/**
 * The auto-run after a submit. Non-blocking, but no longer silent.
 * EdgeRuntime.waitUntil keeps it alive past the response.
 */
function triggerAnalysis(sampleId: string, force = false): void {
  const p = dispatchAnalysis(sampleId, force).then(async (failure) => {
    if (failure) await recordDispatchFailure(sampleId, failure.reason);
  });
  // deno-lint-ignore no-explicit-any
  const er = (globalThis as any).EdgeRuntime;
  if (er?.waitUntil) er.waitUntil(p);
}

// Validate + normalize the POST body into the RPC payload (throws BadRequestError).
// This is the authoritative SERVER-side validation (§4/§15) — the mobile client
// mirrors it for UX, and the RPC guards again as defense-in-depth.
// SCAN → SAMPLE media reuse. Verifies the caller owns the scan, then copies its
// photographs to fresh, sample-owned paths in the same `scan-images` bucket and
// returns them as sample media[]. First image is the field context, the rest are
// close-ups; a lone image is copied into BOTH roles so the sample clears the
// "context + close-up" minimum without a re-shoot. Throws (mapped to 4xx) when
// the scan isn't the caller's or has no photos.
const SCAN_BUCKET = "scan-images";
async function copyScanMediaForActor(
  svc: DbClient,
  actorId: string,
  scanId: string,
): Promise<Array<Record<string, unknown>>> {
  const { data: scan } = await svc.schema("public").from("scans")
    .select("id").eq("id", scanId).eq("user_id", actorId).maybeSingle();
  if (!scan) throw new ForbiddenError("scan not found for this account");

  const { data: images } = await svc.schema("public").from("scan_images")
    .select("angle, original_storage_path, processed_storage_path, width, height, quality_score")
    .eq("scan_id", scanId);
  const rows = (images ?? []) as Array<{
    angle: string | null; original_storage_path: string; processed_storage_path: string | null;
    width: number | null; height: number | null; quality_score: number | null;
  }>;
  if (rows.length === 0) throw new BadRequestError("this scan has no photos to reuse");

  const copyOne = async (src: string): Promise<string> => {
    const ext = (src.split(".").pop() || "jpg").split(/[?#]/)[0];
    const dst = `personal/${actorId}/${crypto.randomUUID()}.${ext}`;
    const { error } = await svc.storage.from(SCAN_BUCKET).copy(src, dst);
    if (error) throw new Error(`scan photo copy failed: ${error.message}`);
    return dst;
  };

  // Each photo copy is an independent Storage call — run them concurrently
  // instead of one round trip at a time. `i` (role: first photo is the
  // "context" shot, everything else is a close-up) is kept from the ORIGINAL
  // row position, not the post-filter index, so this preserves the exact
  // role assignment the sequential loop had.
  const valid = rows
    .map((r, i) => ({ r, i, src: r.processed_storage_path || r.original_storage_path }))
    .filter((e): e is typeof e & { src: string } => !!e.src);
  if (valid.length === 0) throw new BadRequestError("this scan has no usable photos to reuse");
  const copiedPaths = await Promise.all(valid.map((e) => copyOne(e.src)));
  const media: Array<Record<string, unknown>> = valid.map((e, idx) => ({
    role: e.i === 0 ? "context" : "surface_closeup",
    storage_path: copiedPaths[idx],
    width: e.r.width ?? undefined, height: e.r.height ?? undefined,
    image_quality_score: e.r.quality_score ?? undefined,
  }));
  // A single-photo scan still needs a close-up role to pass validation.
  if (media.length === 1) {
    const only = media[0];
    media.push({
      role: "surface_closeup",
      storage_path: await copyOne(String(only.storage_path)),
      width: only.width, height: only.height, image_quality_score: only.image_quality_score,
    });
  }
  return media;
}

export function buildPayload(body: Record<string, unknown>): Record<string, unknown> {
  // Sample name (§1)
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) throw new BadRequestError("sample name is required");

  // GPS (§2)
  const lat = num(body.lat), lng = num(body.lng);
  if (lat === null || lng === null) throw new BadRequestError("GPS (lat/lng) is required");
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new BadRequestError("GPS coordinates out of range");
  if (body.gps_source && !GPS_SOURCES.includes(String(body.gps_source))) throw new BadRequestError("invalid gps_source");
  if (body.location_origin && !LOCATION_ORIGINS.includes(String(body.location_origin))) {
    throw new BadRequestError("invalid location_origin");
  }

  // Collection date (§4)
  if (!body.collected_at) throw new BadRequestError("collection date is required");

  // Enterprise mission context (Phase 2C) — OPTIONAL. When present, this
  // sample is being submitted under a team mission rather than personally.
  // assignment_h3 is computed HERE, server-side, from the same verified
  // lat/lng as h3_cell above — never sent by the client, never trusted from
  // one — submit_sample re-validates mission membership independently.
  const enterpriseMissionId = typeof body.enterprise_mission_id === "string" && body.enterprise_mission_id
    ? body.enterprise_mission_id
    : undefined;
  const assignmentH3 = enterpriseMissionId ? cellFor(lat, lng, H3_RESOLUTION) : undefined;

  // Media + photo minimums (§3): >=1 context and >=1 close-up.
  // A scan-sourced sample sends NO media and a `scan_id` instead — the server
  // copies the scan's photographs in createSample, so the minimums are enforced
  // there (by submit_sample) rather than here.
  const fromScan = typeof body.scan_id === "string" && (body.scan_id as string).length > 0;
  const media = Array.isArray(body.media) ? body.media : [];
  if (!fromScan) {
    let contextPhotos = 0, closeupPhotos = 0;
    for (const m of media as Array<Record<string, unknown>>) {
      if (!m || !MEDIA_ROLES.includes(String(m.role))) throw new BadRequestError(`invalid media role: ${m?.role}`);
      if (!m.storage_path) throw new BadRequestError("each media item needs storage_path");
      if (m.role === "context") contextPhotos++;
      if (CLOSEUP_ROLES.includes(String(m.role))) closeupPhotos++;
    }
    if (contextPhotos === 0) throw new BadRequestError("a field-context photo is required");
    if (closeupPhotos === 0) throw new BadRequestError("a specimen close-up photo is required");
  }

  // Geology is OPTIONAL — the AI determines host rock / minerals. The collector may
  // add them if known, but they never block a submission.
  const obs = (body.observations ?? {}) as Record<string, unknown>;

  // Phase 6 (Solo→Team shared-targeting) — structured evidence (assay/
  // geophysics/mapping/remote_sensing/field_observation), the same five
  // categories Solo's own User Geological Evidence form uses. Shape-checked
  // here (submit_sample re-validates the enum + payload-is-object itself);
  // verification_status/lab_accredited are forwarded as-is — submit_sample
  // is what actually enforces the lab_verified gate, never trust it here.
  const structuredEvidence = Array.isArray(body.structured_evidence)
    ? (body.structured_evidence as Array<Record<string, unknown>>)
        .filter((e) => e && typeof e.evidence_type === "string" && STRUCTURED_EVIDENCE_TYPES.includes(e.evidence_type as string))
        .map((e) => ({
          evidence_type: e.evidence_type,
          payload: e.payload && typeof e.payload === "object" ? e.payload : {},
          verification_status: typeof e.verification_status === "string" ? e.verification_status : undefined,
          lab_accredited: e.lab_accredited === true,
          notes: typeof e.notes === "string" ? e.notes : undefined,
        }))
    : [];

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
    // Lane: the device asserts it. submit_sample defaults to 'personal' when
    // absent; carrying it through is what keeps a mission's evidence recorded as
    // 'exploration' (and a scanned specimen as 'personal').
    origin: body.origin === "exploration" ? "exploration" : "personal",
    field_mission_id: typeof body.field_mission_id === "string" ? body.field_mission_id : undefined,
    // Enterprise team mission (Phase 2C) — deliberately separate keys from
    // the solo field_mission_id above; submit_sample keeps the two systems
    // from ever being confused at the payload level.
    enterprise_mission_id: enterpriseMissionId,
    assignment_h3: assignmentH3,
    location_origin: body.location_origin ?? undefined,
    // A scan-sourced sample carries the scanId (server copies its photos) and NO
    // media; every other sample carries its uploaded media and no scanId.
    ...(fromScan ? { scan_id: body.scan_id } : { media }),
    observations: obs,
    structured_evidence: structuredEvidence,
  };
}

export async function handleSamples(req: Request, deps: Deps = defaultDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const actor = await deps.resolveActor(req);
    // Default gate: owner, active-org, OR a paid consumer plan (Explorer / Gem
    // Collector). This admits everyone requireEnterprise admits, plus paid users
    // managing their OWN (RLS-scoped) personal samples. Creating EXPLORATION-lane
    // evidence layers the stricter requireEnterprise on top, in the POST branch.
    await deps.requirePersonalSampleAccess(actor);
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
      // Exploration-lane evidence (a mission's field data) stays enterprise-only;
      // personal specimens are open to the paid consumer plans already gated above.
      // A team-mission sample is exploration-lane by definition regardless of
      // what `origin` claims — gated independently so a payload can't skip
      // this by simply omitting/misrepresenting origin.
      if (String(body.origin ?? "personal") === "exploration" || typeof body.enterprise_mission_id === "string") {
        await deps.requireEnterprise(actor);
      }
      const created = await deps.createSample(actor, buildPayload(body));
      return json(created, 201);
    }
    if (req.method === "GET" && id) {
      const s = await deps.getSample(req, actor, id);
      if (!s) throw new NotFoundError("sample not found");
      return json(s);
    }
    if (req.method === "GET") {
      // ?origin=personal — what My Samples asks for. Validated against the enum
      // rather than passed through: an unrecognised value must not silently
      // become "no filter" and hand back a mission's evidence.
      const params = new URL(req.url).searchParams;
      const raw = params.get("origin");
      const origin = raw === "personal" || raw === "exploration" ? raw : undefined;
      const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, num(params.get("limit")) ?? DEFAULT_LIST_LIMIT));
      const offset = Math.max(0, num(params.get("offset")) ?? 0);
      return json({ samples: await deps.listSamples(req, actor, origin, { limit, offset }) });
    }
    return json({ error: "method not allowed" }, 405);
  } catch (err) {
    return errorResponse(err);
  }
}

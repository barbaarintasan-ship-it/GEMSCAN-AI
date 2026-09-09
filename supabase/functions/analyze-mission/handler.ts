// analyze-mission — the field mission's assessment, and the gate in front of it.
//
//   POST /analyze-mission        { missionId }   verify the evidence, then assess
//   GET  /analyze-mission/health                 is object storage actually reachable
//
// WHY THIS IS NOT PART OF expeditions/sync
// ----------------------------------------
// Sync is EVIDENCE PRESERVATION. It takes a walk's worth of records in one round
// trip and must stay fast, because the caller is a phone on a cellular link in a
// wadi and every second is a chance to fail. Analysis is INTERPRETATION: a HEAD
// against R2 per photograph plus a reasoning model, tens of seconds on a good day.
//
// Folded together, a slow model would time out a request whose evidence had
// already landed — and the geologist would be told their day's work failed when it
// had not. Worse, an outage in the model would make the sync endpoint look broken.
// The one rule this system has is that interpretation must never be able to
// destroy collection, so the two are separate deployments with separate secrets.
//
// THE ORDER OF OPERATIONS IS THE DESIGN
// -------------------------------------
//   1. load the package exactly as the device sent it
//   2. HEAD every photograph named in it            ← once, and only once
//   3. record what was verified                     ← state moves to ready_for_ai
//   4. if anything is missing, STOP and say which   ← the model is never called
//   5. assess, reusing step 2's results
//
// Step 4 is the one that matters. A model handed nine of a mission's ten
// photographs writes a report that reads exactly like a complete one — same
// confidence, same conclusions, no indication anything is absent. "The device said
// it uploaded" is not evidence; the bytes being there is.
import { corsHeaders } from "../_shared/cors.ts";
import {
  BadRequestError, ForbiddenError, NotFoundError, errorResponse, json,
} from "../_shared/enterprise/errors.ts";
import { resolveActor as realResolveActor, type Actor } from "../_shared/enterprise/auth.ts";
import { serviceClient } from "../_shared/enterprise/clients.ts";
import { requireEnterprise as realRequireEnterprise } from "../_shared/enterprise/authz.ts";
import {
  photoKeyFor, presignR2Url, r2ConfigFromEnv, type R2Config,
} from "../_shared/r2/sign.ts";
import {
  photosInPackage, summariseVerification, verifyObjects,
  type VerifiedObject, type VerificationSummary,
} from "../_shared/r2/verify.ts";
import {
  analyzeExplorationPackage, geminiProvider,
  type AIProvider, type AnalyzeOutcome,
} from "../_shared/gie/analyzeMission.ts";
import { runVision, defaultVisionDeps } from "../_shared/gie/vision.ts";
import type { EnginePackageSummary, StructuredEvidenceSummary } from "../_shared/gie/missionPrompt.ts";
import type { MissionFindings } from "../../../shared/geo-core/gie/missionFindings.ts";

/**
 * Is this bearer token the project's own service role?
 *
 * TWO TESTS, and the second is the one that works in practice.
 *
 * An exact match against `SUPABASE_SERVICE_ROLE_KEY` is unambiguous and free, so
 * it is tried first. But it is also brittle: the key the dashboard shows and the
 * key injected into a function's environment can be two different strings after
 * the project's JWT signing keys are rotated, and then a perfectly valid
 * service-role token is refused with nothing to explain why. That is not
 * hypothetical — it is what sent this function's health check into a 401 loop.
 *
 * So the fallback reads the `role` claim. That is ONLY safe because this function
 * runs with `verify_jwt = true` (supabase/config.toml): the platform gateway has
 * already checked the signature against the project's JWT secret before the
 * request reaches any of this code. A forged token claiming
 * `role: service_role` never arrives here — it is rejected upstream.
 *
 * If that setting is ever turned off, this becomes forgeable by anyone. The
 * config and this function are one decision; changing either alone is a hole.
 */
export function isServiceRole(authHeader: string | null, injectedKey?: string): boolean {
  const m = /^Bearer\s+(.+)$/.exec(authHeader ?? "");
  if (!m) return false;
  const token = m[1].trim();
  if (injectedKey && token === injectedKey) return true;
  return roleClaimOf(token) === "service_role";
}

/** The `role` claim, or null when the token is not a readable JWT. */
export function roleClaimOf(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")));
    return typeof payload?.role === "string" ? payload.role : null;
  } catch {
    // Unreadable is not service_role. Never throw here: this decides an auth
    // branch, and an exception would be a 500 where a plain "no" belongs.
    return null;
  }
}

/** The package as `geo.upsert_mission_package` stored it, verbatim. */
export interface StoredPackage {
  packageId: string;
  missionId: string;
  payload: Record<string, unknown>;
  filesVerifiedAt: string | null;
}

export interface AnalyzeMissionDeps {
  resolveActor: (req: Request) => Promise<Actor>;
  requireEnterprise: (actor: Actor) => Promise<void>;
  /**
   * Is this the operator, calling with the service role?
   *
   * `/health` alone accepts it. A health check reachable only from a signed-in
   * phone is not much of a health check: the question it answers — do the storage
   * credentials this deployment holds actually work — is an operator's question,
   * asked from a terminal or from CI, usually at the moment something is wrong.
   *
   * It exposes no user data and reads no row. Every other route still requires a
   * real user and the enterprise gate.
   */
  isOperator: (req: Request) => boolean;
  /** Null when the caller does not own the mission, or it does not exist. */
  loadPackage: (actor: Actor, missionId: string) => Promise<StoredPackage | null>;
  /** Records which photographs were seen, and moves the mission to ready_for_ai. */
  markVerified: (
    actor: Actor, missionId: string, verified: VerificationSummary["verified"],
  ) => Promise<number>;
  verify: (config: R2Config, keys: readonly string[]) => Promise<VerifiedObject[]>;
  provider: () => AIProvider;
  config: () => { config: R2Config } | { missing: string[] } | { conflict: string };
  now: () => number;
  /**
   * The most recent report for this mission, if one exists.
   *
   * What makes POST safe to call repeatedly. The device polls — it has to, since
   * an analysis it triggered before losing signal has to be collectable
   * afterwards — and without this every poll would run the model again: a bill
   * per poll, and two readings of one mission that can disagree with each other.
   */
  loadReport: (
    actor: Actor, missionId: string,
  ) => Promise<{ reportId: string; findings: MissionFindings } | null>;
  /**
   * Records what the model read from each photograph.
   *
   * Written to `evidence_photo.ai_description`, which is deliberately a DIFFERENT
   * column from `caption`: the caption is the geologist's own words and this is a
   * model's reading of an image. A report that blurs the two quietly promotes a
   * guess to an observation.
   */
  savePhotoDescriptions: (
    actor: Actor, missionId: string,
    described: Array<{ id: string; description: string }>,
  ) => Promise<number>;
  /** Writes the findings and moves the mission to ai_analysis_complete, together. */
  saveReport: (
    actor: Actor, missionId: string, packageId: string, findings: MissionFindings,
  ) => Promise<string>;
  /**
   * Records WHY a reading did not come back, and touches no evidence.
   *
   * A mission that failed analysis and one nobody has analysed yet look identical
   * without this, and the difference is whether anyone should try again.
   */
  failAnalysis: (actor: Actor, missionId: string, reason: string) => Promise<number>;
}

export const realDeps: AnalyzeMissionDeps = {
  resolveActor: realResolveActor,
  requireEnterprise: (a) => realRequireEnterprise(a, serviceClient()),

  isOperator: (req) => isServiceRole(
    req.headers.get("Authorization"),
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  ),

  loadPackage: async (actor, missionId) => {
    // `user_id` is in the filter, not merely checked afterwards. Mission ids are
    // generated on the device as ms-{base36}-{seq} and are guessable, so the
    // ownership test belongs in the query that fetches the row.
    const { data, error } = await serviceClient("geo")
      .from("mission_package")
      .select("id,mission_id,payload,files_verified_at")
      .eq("mission_id", missionId)
      .eq("user_id", actor.userId)
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return {
      packageId: data.id as string,
      missionId: data.mission_id as string,
      payload: (data.payload ?? {}) as Record<string, unknown>,
      filesVerifiedAt: (data.files_verified_at ?? null) as string | null,
    };
  },

  markVerified: async (actor, missionId, verified) => {
    const { data, error } = await serviceClient("geo").rpc("mark_photos_verified", {
      p_actor: actor.userId,
      p_mission: missionId,
      p_verified: verified.map((v) => ({ id: v.id, bytes: v.bytes })),
    });
    if (error) throw new Error(`mark_photos_verified: ${error.message}`);
    return typeof data === "number" ? data : 0;
  },

  verify: (config, keys) => verifyObjects(config, keys),
  provider: geminiProvider,
  config: () => r2ConfigFromEnv((k) => Deno.env.get(k)),
  now: () => Date.now(),

  loadReport: async (actor, missionId) => {
    const { data, error } = await serviceClient("geo")
      .from("mission_report")
      .select("id,findings")
      .eq("mission_id", missionId)
      .eq("user_id", actor.userId)
      .not("findings", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return { reportId: data.id as string, findings: data.findings as MissionFindings };
  },

  savePhotoDescriptions: async (actor, missionId, described) => {
    if (described.length === 0) return 0;
    const { data, error } = await serviceClient("geo").rpc("save_photo_descriptions", {
      p_actor: actor.userId,
      p_mission: missionId,
      p_described: described,
    });
    if (error) throw new Error(`save_photo_descriptions: ${error.message}`);
    return typeof data === "number" ? data : 0;
  },

  saveReport: async (actor, missionId, packageId, findings) => {
    const { data, error } = await serviceClient("geo").rpc("save_mission_report", {
      p_actor: actor.userId,
      p_mission: missionId,
      p_package: packageId,
      p_findings: findings,
    });
    if (error) throw new Error(`save_mission_report: ${error.message}`);
    return String(data);
  },

  failAnalysis: async (actor, missionId, reason) => {
    const { data, error } = await serviceClient("geo").rpc("fail_mission_analysis", {
      p_actor: actor.userId,
      p_mission: missionId,
      p_reason: reason,
    });
    if (error) throw new Error(`fail_mission_analysis: ${error.message}`);
    return typeof data === "number" ? data : 0;
  },
};

/**
 * What the analysis is given about the ground, from the package the device built.
 *
 * The engine's own numbers are passed through UNTOUCHED — `prospectivityScore`
 * above all. It is a ranking the offline engine computed at the moment the target
 * was offered, it is what the geologist was told, and nothing here may recompute
 * or second-guess it. The prompt says so too; this is where it is made true.
 *
 * Readings the package does not carry come through as null, which the prompt
 * renders as NOT AVAILABLE — deliberately different from "measured and absent".
 */
export function engineSummaryFrom(pkg: StoredPackage): EnginePackageSummary {
  const p = pkg.payload as Record<string, any>;
  const observations = Array.isArray(p.observations) ? p.observations : [];
  const centre = p.targetCentre ?? {};
  const coverage = Array.isArray(p.coverage?.roles) ? p.coverage.roles : [];

  return {
    missionId: pkg.missionId,
    commodity: p.commodity ?? null,
    prospectivityScore: Number(p.prospectivityScore ?? 0),
    targetCell: String(p.targetCell ?? ""),
    lat: Number(centre.lat ?? 0),
    lng: Number(centre.lng ?? 0),
    gpsAccuracyM: firstAccuracy(observations),
    lithology: p.geologyContext ?? null,
    terrainMorphology: p.terrainContext ?? null,
    // The engine's own numeric readings, carried by the package since v2.
    //
    // Absent on v1 packages, and null is then correct: nothing measured them.
    // Null renders as NOT AVAILABLE, which the model reports as evidence nobody
    // looked at — accurate for v1, and previously WRONG for every package,
    // because the engine had measured all four before offering the target.
    elevationM: num(p.engineReadings?.elevationM),
    faultDistanceM: num(p.engineReadings?.faultDistanceM),
    contactDistanceM: num(p.engineReadings?.contactDistanceM),
    drainageDistanceM: num(p.engineReadings?.drainageDistanceM),
    coverage: coverage.map((r: any) => ({ role: String(r.role), status: r.status })),
    engineReasons: Array.isArray(p.targetReasons)
      ? p.targetReasons.map((r: any) => String(r?.kind ?? r?.code ?? r)).filter(Boolean)
      : [],
    observations: observations.map((o: any) => ({
      type: String(o?.type ?? "other"),
      notes: String(o?.notes ?? ""),
      positionQuality: String(o?.positionQuality ?? "unknown"),
      photoCount: Array.isArray(o?.photos) ? o.photos.length : 0,
      // Named so a reading taken from an image can cite it, and the report can
      // put the description beside the photograph it describes.
      photoIds: Array.isArray(o?.photos)
        ? o.photos.map((ph: any) => String(ph?.id ?? "")).filter(Boolean)
        : [],
    })),
    photoCount: observations.reduce(
      (n: number, o: any) => n + (Array.isArray(o?.photos) ? o.photos.length : 0), 0,
    ),
    trackPoints: Array.isArray(p.track) ? p.track.length : 0,
    structuredEvidence: structuredEvidenceSummaryFrom(p.structuredEvidence),
  };
}

/**
 * The package's `structuredEvidence` (evidencePackage.ts's field of the same
 * name, carried verbatim from the device — see StructuredEvidenceForm.tsx /
 * structuredEvidenceTypes.ts), read defensively rather than imported typed:
 * that type lives in the mobile-only tree and cannot be imported here, and by
 * the time it reaches this JSONB payload it is untyped JSON regardless.
 *
 * Undefined — not an object with five empty arrays — when nothing was
 * entered, or the field predates this package version. That is what lets
 * `structuredEvidenceSection()` (missionPrompt.ts) skip the block entirely
 * rather than print five empty headings, which would read as "checked, found
 * nothing" when the truth is "never asked".
 *
 * NO GATING, NO RE-SCORING. `verificationStatus`/`labAccredited` are carried
 * exactly as entered — the honesty rule lives in the prompt itself (ABSOLUTE
 * RULES §6), not here, because the gate that already exists for THIS data —
 * `gatedTier()` in structuredEvidenceSource.ts — lives in the mobile tree and
 * governs the DETERMINISTIC score, a separate concern this function must not
 * duplicate or drift from.
 */
function structuredEvidenceSummaryFrom(raw: unknown): StructuredEvidenceSummary | undefined {
  const s = raw as Record<string, any> | null | undefined;
  if (!s || typeof s !== "object") return undefined;
  const list = (v: unknown): any[] => Array.isArray(v) ? v : [];

  const assays = list(s.assays).map((a) => ({
    element: String(a?.element ?? ""),
    result: Number(a?.result),
    unit: String(a?.unit ?? ""),
    sampleType: String(a?.sampleType ?? ""),
    sampleId: String(a?.sampleId ?? ""),
    samplingDate: typeof a?.samplingDate === "string" ? a.samplingDate : null,
    verificationStatus: String(a?.verificationStatus ?? "user_reported"),
    labAccredited: a?.labAccredited === true,
    labName: String(a?.labName ?? ""),
    notes: String(a?.notes ?? ""),
    // A malformed entry (no element, no finite result) is dropped here rather
    // than shown to the model as "undefined ppm undefined" — the form itself
    // never saves one, so this only guards against corrupt/old data.
  })).filter((a) => a.element.length > 0 && Number.isFinite(a.result));

  const geophysics = list(s.geophysics).map((g) => ({
    surveyType: String(g?.surveyType ?? "other"),
    anomalyPresent: g?.anomalyPresent === true,
    anomalyDescription: String(g?.anomalyDescription ?? ""),
    magnitude: num(g?.magnitude),
    surveyArea: String(g?.surveyArea ?? ""),
    interpretation: String(g?.interpretation ?? ""),
    verificationStatus: String(g?.verificationStatus ?? "user_reported"),
    notes: String(g?.notes ?? ""),
  }));

  const mapping = list(s.mapping).map((m) => ({
    hostLithology: String(m?.hostLithology ?? ""),
    rockType: String(m?.rockType ?? ""),
    formationUnit: String(m?.formationUnit ?? ""),
    alteration: String(m?.alteration ?? ""),
    veinType: String(m?.veinType ?? ""),
    veinWidthM: num(m?.veinWidthM),
    veinOrientation: String(m?.veinOrientation ?? ""),
    strikeDeg: num(m?.strikeDeg),
    dipDeg: num(m?.dipDeg),
    fault: m?.fault === true,
    shearZone: m?.shearZone === true,
    fold: m?.fold === true,
    breccia: m?.breccia === true,
    gossan: m?.gossan === true,
    sulfides: m?.sulfides === true,
    visibleMineralization: String(m?.visibleMineralization ?? ""),
    mineralAssemblage: String(m?.mineralAssemblage ?? ""),
    structuralRelationship: String(m?.structuralRelationship ?? ""),
    mappingConfidence: String(m?.mappingConfidence ?? "user_reported"),
    notes: String(m?.notes ?? ""),
  }));

  const remoteSensing = list(s.remoteSensing).map((r) => ({
    source: String(r?.source ?? "other"),
    alterationAnomaly: String(r?.alterationAnomaly ?? ""),
    spectralAnomaly: String(r?.spectralAnomaly ?? ""),
    structuralAnomaly: String(r?.structuralAnomaly ?? ""),
    lineamentInterpretation: String(r?.lineamentInterpretation ?? ""),
    areaCovered: String(r?.areaCovered ?? ""),
    interpretation: String(r?.interpretation ?? ""),
    confidence: String(r?.confidence ?? "user_reported"),
    notes: String(r?.notes ?? ""),
  }));

  const fieldObservations = list(s.fieldObservations).map((f) => ({
    visibleMineral: f?.visibleMineral === true,
    quartzVein: f?.quartzVein === true,
    gossanRust: f?.gossanRust === true,
    sulfides: f?.sulfides === true,
    alteration: f?.alteration === true,
    shearing: f?.shearing === true,
    faultExposure: f?.faultExposure === true,
    oldWorkings: f?.oldWorkings === true,
    activeArtisanalMining: f?.activeArtisanalMining === true,
    pits: f?.pits === true,
    shafts: f?.shafts === true,
    adits: f?.adits === true,
    tailings: f?.tailings === true,
    historicalProduction: f?.historicalProduction === true,
    localMiningEvidence: f?.localMiningEvidence === true,
    otherObservations: String(f?.otherObservations ?? ""),
    expertInterpretation: String(f?.expertInterpretation ?? ""),
    confidence: String(f?.confidence ?? "user_reported"),
    notes: String(f?.notes ?? ""),
    // Tri-state preserved: only keys the geologist explicitly set true survive
    // this filter, exactly as ConfirmedAbsentFindings (structuredEvidenceTypes.ts)
    // requires — "not mentioned" must never read as "confirmed absent".
    ...(f?.confirmedAbsent && typeof f.confirmedAbsent === "object"
      ? {
          confirmedAbsent: Object.fromEntries(
            Object.entries(f.confirmedAbsent as Record<string, unknown>)
              .filter((e): e is [string, true] => e[1] === true),
          ),
        }
      : {}),
  }));

  if (
    assays.length === 0 && geophysics.length === 0 && mapping.length === 0 &&
    remoteSensing.length === 0 && fieldObservations.length === 0
  ) {
    return undefined;
  }
  return { assays, geophysics, mapping, remoteSensing, fieldObservations };
}

/** A finite number, or null. Never 0 for "absent" — 0 metres is a real reading. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function firstAccuracy(observations: any[]): number | null {
  for (const o of observations) {
    const a = o?.position?.accuracyM;
    if (typeof a === "number") return a;
  }
  return null;
}

/** The analysis result, plus what the verification pass found on the way. */
export interface AnalyzeMissionResult {
  missionId: string;
  packageId: string;
  outcome: AnalyzeOutcome;
  verification: VerificationSummary | null;
  verifiedNow: number;
  /** Set only when findings were written. */
  reportId?: string;
}

export async function runAnalysis(
  actor: Actor, missionId: string, deps: AnalyzeMissionDeps,
  opts: { force?: boolean } = {},
): Promise<AnalyzeMissionResult> {
  const pkg = await deps.loadPackage(actor, missionId);
  if (!pkg) throw new NotFoundError(`no package for mission ${missionId}`);

  // ALREADY READ? Then this is a collection, not an analysis.
  //
  // The device polls, and it must: an analysis triggered before the signal went
  // is collected after it comes back. Without this, every poll would run the
  // model again — a bill per poll, and two readings of one mission free to
  // disagree with each other. `force` exists for a deliberate re-read and is the
  // only way past it.
  if (!opts.force) {
    const existing = await deps.loadReport(actor, missionId);
    if (existing) {
      return {
        missionId, packageId: pkg.packageId, verification: null, verifiedNow: 0,
        reportId: existing.reportId,
        outcome: {
          status: "analysed", findings: existing.findings,
          discarded: [], violations: [], verification: null,
        },
      };
    }
  }

  const cfg = deps.config();
  if ("missing" in cfg || "conflict" in cfg) {
    // Not an analysis failure and not the mission's fault: the operator has not
    // configured storage. Reported as such so the package waits rather than
    // being recorded as unanalysable.
    throw new StorageUnconfiguredError(
      "missing" in cfg ? `not configured: ${cfg.missing.join(", ")}` : cfg.conflict,
    );
  }

  const photos = photosInPackage(pkg.payload as never);
  let verification: VerificationSummary | null = null;
  let verifiedNow = 0;
  let results: VerifiedObject[] = [];

  if (photos.length > 0) {
    // ONCE. The same results are handed to the analysis below rather than HEADing
    // every object a second time — a mission with thirty photographs would
    // otherwise pay for sixty round trips to learn one thing.
    results = await deps.verify(cfg.config, photos.map((p) => p.key));
    verification = summariseVerification(photos, results);

    // Recorded BEFORE the completeness test, so a partial upload still marks off
    // what did arrive. A photograph verified once never has to be checked again.
    if (verification.verified.length > 0) {
      verifiedNow = await deps.markVerified(actor, missionId, verification.verified);
    }

    if (!verification.complete) {
      return {
        missionId, packageId: pkg.packageId, verification, verifiedNow,
        outcome: { status: "blocked", reason: "photos_not_in_storage", verification },
      };
    }
  }

  const byKey = new Map(results.map((r) => [r.key, r]));
  const outcome = await analyzeExplorationPackage(
    { engine: engineSummaryFrom(pkg), payload: pkg.payload as never },
    {
      provider: deps.provider(),
      r2: cfg.config,
      // Reuse, never re-fetch. Passing the real verifier here would double every
      // HEAD and could even disagree with the decision already recorded above.
      verify: async (_c, keys) => keys.map((k) =>
        byKey.get(k) ?? { key: k, exists: false, bytes: null, status: 0 }),
      // Read the photographs: presign a short-lived GET per verified key, then run
      // the vision stage (resize → Gemini) over them. Enrichment only — if it
      // throws, analyzeExplorationPackage swallows it and reports with no visual
      // section.
      vision: async (photoRefs) => {
        const urls = await Promise.all(photoRefs.map((p) =>
          presignR2Url({ config: cfg.config, key: p.key, method: "GET", expiresIn: 300 })));
        return runVision(urls, defaultVisionDeps);
      },
      now: deps.now,
    },
  );

  // ── Persist ───────────────────────────────────────────────────────────────
  //
  // Only two outcomes touch the database, and neither touches the evidence.
  //
  //   analysed → the findings, and the state, in one transaction
  //   failed   → the reason, and an attempt counted
  //
  // `blocked` deliberately writes nothing: the photographs are still arriving,
  // which is waiting, not failing, and recording it as a failure would make a
  // mission look broken minutes before it completes on its own.
  //
  // `refused / storage_not_configured` never reaches here — it is thrown above as
  // StorageUnconfiguredError, because an operator's missing secret is not
  // something to hold against a geologist's mission.
  if (outcome.status === "analysed") {
    // Descriptions first, and never allowed to fail the report. The assessment is
    // the thing that matters; a caption that did not save is a missing sentence,
    // not a missing reading, and losing the whole analysis over one would be the
    // wrong trade every time.
    try {
      await deps.savePhotoDescriptions(actor, missionId, photoDescriptionsFrom(outcome.findings));
    } catch (e) {
      console.error(`analyze-mission ${missionId}: photo descriptions not saved —`, e);
    }
    const reportId = await deps.saveReport(actor, missionId, pkg.packageId, outcome.findings);
    return { missionId, packageId: pkg.packageId, outcome, verification, verifiedNow, reportId };
  }

  if (outcome.status === "failed") {
    await deps.failAnalysis(actor, missionId, `${outcome.reason}: ${outcome.detail}`);
  } else if (outcome.status === "refused") {
    // package_incomplete will refuse identically for ever. Recording it stops the
    // device asking again and tells a reader why nothing is coming.
    await deps.failAnalysis(actor, missionId, `${outcome.reason}: ${outcome.detail}`);
  }

  return { missionId, packageId: pkg.packageId, outcome, verification, verifiedNow };
}

/**
 * What the model said about each photograph, from the findings it returned.
 *
 * Only `origin: "photograph"` evidence carries a photo id, and only that is
 * written back — an engine layer with a photo id attached is the model having
 * misunderstood the question, not a fact about an image.
 *
 * The description is the significance CODE, humanised at the edge like every
 * other code in this system. Storing prose here would be a second place the
 * report's language could disagree with itself.
 */
export function photoDescriptionsFrom(
  findings: MissionFindings,
): Array<{ id: string; description: string }> {
  const byPhoto = new Map<string, string[]>();
  for (const e of findings.evidence) {
    if (e.origin !== "photograph" || !e.photoId) continue;
    const parts = byPhoto.get(e.photoId) ?? [];
    parts.push(`${e.type}:${e.significance}`);
    byPhoto.set(e.photoId, parts);
  }
  return [...byPhoto].map(([id, parts]) => ({ id, description: parts.join(" ") }));
}

/** Storage is not set up. Distinct from an analysis that ran and failed. */
export class StorageUnconfiguredError extends Error {}

/**
 * Is object storage genuinely reachable, with the credentials this deployment has?
 *
 * Presigning is local arithmetic — it proves nothing about whether the keys work.
 * So this signs a HEAD for a key that is not expected to exist and reports what R2
 * said. 404 is the PASS: the request was signed, accepted and answered. 403 means
 * the credentials or the bucket are wrong, which is the failure worth catching
 * before a geologist walks 130 km and finds out afterwards.
 */
export interface StorageHealth {
  ok: boolean;
  detail: string;
  status?: number;
  /**
   * What this deployment actually signed with — NOT the secret.
   *
   * "Check your three variables" is not a diagnosis, it is a list of things to
   * worry about. What an operator needs is the bucket and host the server used,
   * so they can put it beside the Cloudflare dashboard and see the difference in
   * one glance. This route is service-role only, so the reader is the project
   * owner, and none of it is secret: the bucket name and account id appear in
   * every presigned URL the app already hands to devices.
   *
   * The access key id is shown as a prefix and a length. That is enough to answer
   * "did I paste the right one" and not enough to be one.
   */
  using?: {
    bucket: string;
    host: string;
    accessKeyIdPrefix: string;
    accessKeyIdLength: number;
    /**
     * The secret's LENGTH and shape — never a character of it.
     *
     * R2 issues a 64-character hex secret. A secret pasted into a dashboard field
     * with a trailing newline, or truncated on the way, produces exactly one
     * symptom: `SignatureDoesNotMatch`, which R2 returns as a bare 403 that looks
     * identical to wrong credentials, a wrong bucket and a wrong account. It is
     * the least diagnosable failure in the protocol and the most common cause of
     * it is invisible whitespace.
     *
     * A length and a boolean settle it in one request, and neither is secret: 64
     * is a published constant, and "does it have a space in it" is not a key.
     */
    secretLength: number;
    secretLooksHex: boolean;
    secretHasWhitespace: boolean;
    accessKeyHasWhitespace: boolean;
    bucketHasWhitespace: boolean;
    probeKey: string;
  };
}

export async function checkStorage(deps: AnalyzeMissionDeps): Promise<StorageHealth> {
  const cfg = deps.config();
  if ("missing" in cfg) return { ok: false, detail: `not configured: ${cfg.missing.join(", ")}` };
  if ("conflict" in cfg) return { ok: false, detail: cfg.conflict };

  const c = cfg.config;
  const key = photoKeyFor("__healthcheck__", "probe", "image/jpeg");
  const hasSpace = (s: string) => /\s/.test(s);
  const using: StorageHealth["using"] = {
    bucket: c.bucket,
    host: c.host ?? `${c.accountId}.r2.cloudflarestorage.com`,
    accessKeyIdPrefix: c.accessKeyId.slice(0, 6),
    accessKeyIdLength: c.accessKeyId.length,
    secretLength: c.secretAccessKey.length,
    secretLooksHex: /^[0-9a-f]+$/i.test(c.secretAccessKey),
    secretHasWhitespace: hasSpace(c.secretAccessKey),
    accessKeyHasWhitespace: hasSpace(c.accessKeyId),
    bucketHasWhitespace: hasSpace(c.bucket),
    probeKey: key,
  };

  try {
    const url = await presignR2Url({ config: c, key, method: "HEAD", expiresIn: 60 });
    const res = await fetch(url, { method: "HEAD" });
    if (res.status === 404 || (res.status >= 200 && res.status < 300)) {
      return {
        ok: true, status: res.status, using,
        detail: "storage reachable and credentials accepted",
      };
    }
    return {
      ok: false,
      status: res.status,
      using,
      detail: res.status === 403
        // Named in the order they are worth checking. A 403 on a HEAD of an object
        // that does not exist is almost never the object — it is the credentials,
        // or a token scoped to a different bucket than the one named here.
        ? "R2 refused the signature. Most likely, in order: the token is scoped to a " +
          "different bucket than the one below; the access key/secret pair is wrong; " +
          "or an Account API token was created instead of an R2 token (an R2 token is " +
          "the one that gives an Access Key ID and a Secret Access Key)"
        : res.status === 404
          ? "no such bucket at this account"
          : `R2 answered HTTP ${res.status}`,
    };
  } catch (e) {
    return {
      ok: false, using,
      detail: `could not reach R2: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function handleAnalyzeMission(
  req: Request, deps: AnalyzeMissionDeps = realDeps,
): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const path = new URL(req.url).pathname.replace(/^\/analyze-mission\/?/, "").replace(/\/$/, "");

    // The operator's own route, answered BEFORE resolveActor — the service role
    // is not a user and `auth.getUser()` would reject it. Nothing below this
    // branch is reachable without a real signed-in account.
    if (req.method === "GET" && path === "health" && deps.isOperator(req)) {
      const storage = await checkStorage(deps);
      return json({ storage, as: "operator" }, storage.ok ? 200 : 503);
    }

    const actor = await deps.resolveActor(req);
    await deps.requireEnterprise(actor);

    if (req.method === "GET" && path === "health") {
      const storage = await checkStorage(deps);
      return json({ storage }, storage.ok ? 200 : 503);
    }

    if (req.method !== "POST" || path !== "") {
      throw new BadRequestError("POST /analyze-mission or GET /analyze-mission/health");
    }

    const body = await req.json().catch(() => null) as
      { missionId?: unknown; force?: unknown } | null;
    const missionId = typeof body?.missionId === "string" ? body.missionId : "";
    if (!missionId) throw new BadRequestError("missionId is required");

    const result = await runAnalysis(actor, missionId, deps, { force: body?.force === true });

    // 409, not 200 with a sad payload. The device must be able to tell "come back
    // when the photographs have finished uploading" from "here is your report",
    // and a status code is the one part of a response every layer agrees on.
    if (result.outcome.status === "blocked") {
      return json({
        missionId, status: "blocked",
        missing: result.outcome.verification.missing,
        verifiedNow: result.verifiedNow,
      }, 409);
    }
    return json({ ...result, status: result.outcome.status });
  } catch (err) {
    if (err instanceof StorageUnconfiguredError) {
      // 503: nothing is broken and nothing is lost. The evidence stays exactly
      // where it is and the analysis can be asked for again once storage is set up.
      return json({ error: "object storage is not configured", detail: err.message }, 503);
    }
    if (err instanceof ForbiddenError) return errorResponse(err);
    return errorResponse(err);
  }
}

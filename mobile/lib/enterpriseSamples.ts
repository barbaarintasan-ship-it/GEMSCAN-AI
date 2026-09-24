// Enterprise Sample Submission API client (Sprint 4.2 — owner beta).
//
// Thin wrapper over the `enterprise-samples` Edge Function. It only carries the
// signed-in user's JWT (same pattern as scanUpload/goldVerification); it never
// touches payment or Stripe keys. Server-side, resolveActor re-verifies the JWT
// and requireEnterprise gates access to the owner allowlist, so this client
// stays deliberately dumb — validation and authorization are enforced there.
import { decode } from "base64-arraybuffer";
import * as FileSystem from "expo-file-system";
import * as ImageManipulator from "expo-image-manipulator";
import { resizeTargetFor, UPLOAD_JPEG_QUALITY } from "./photoBudget";
import * as Location from "expo-location";
import { getAuthUserTimed } from "./getAuthUserTimed";
import { supabase } from "./supabase";

const FUNCTIONS_URL = process.env.EXPO_PUBLIC_SUPABASE_FUNCTIONS_URL!;

// The private-beta gate. Enterprise is a closed beta locked to the owner; the
// server enforces this (requireEnterprise) — this is only to hide the UI entry
// point from everyone else. Mirrors the backend isOwnerEmail allowlist.
export const OWNER_EMAIL = "awmusse.musse@gmail.com";
export function isOwnerEmail(email?: string | null): boolean {
  return !!email && email.trim().toLowerCase() === OWNER_EMAIL;
}

export type MediaRole =
  | "context"
  | "surface_closeup"
  | "texture_structure"
  | "key_feature"
  | "scale_reference"
  | "extra";

export type SampleMediaInput = { role: MediaRole; storage_path: string; thumb_path?: string };

export type MineralObservationInput = { mineral: string; confidence?: number };

export type NewSampleInput = {
  name: string;
  lat: number;
  lng: number;
  gps_accuracy_m?: number;
  altitude_m?: number;
  gps_source?: "gps" | "fused" | "network" | "manual";
  collected_at?: string;
  field_observations?: string;
  /** personal = a collected/scanned specimen; exploration = a mission's evidence. */
  origin?: "personal" | "exploration";
  /** The SOLO geo.field_mission id — unrelated to enterprise_mission_id below. */
  field_mission_id?: string | null;
  /**
   * Team Mission Mode (Phase 2C) — the enterprise.exploration_mission this
   * sample was collected under. Deliberately a separate field from the solo
   * field_mission_id above; the server keeps the two entirely apart. Not yet
   * set by any screen (no mission-picker UI exists) — carried here purely so
   * the type contract exists and the field survives the offline queue
   * unmodified (LocalSample stores this whole payload object) once a future
   * screen starts setting it.
   */
  enterprise_mission_id?: string;
  /**
   * GPS provenance (Phase 2C). 'observed' (default) = the collector recorded
   * this location themselves; 'reported' = it came from another source. The
   * server never infers or overwrites this — always exactly what was sent.
   */
  location_origin?: "observed" | "reported";
  /**
   * Scan → Sample bridge. When set, the server reuses THIS scan's photographs
   * (copied to sample-owned storage) and `media` is omitted — the user does not
   * re-shoot the rock. Gated to paid plans server-side.
   */
  scan_id?: string;
  observations?: {
    // `method` records provenance: 'ai' = a scan/photo candidate (a guess, shown
    // editable and unconfirmed), 'field' = the collector asserted it. Defaults to
    // 'field' server-side when omitted.
    rock?: { rock_class?: string; texture?: string; notes?: string; method?: "field" | "ai" | "expert" } | null;
    minerals?: MineralObservationInput[];
  };
  media?: SampleMediaInput[];
  /**
   * The device's own id for this submission, when it was queued offline.
   *
   * The server's idempotency key (migration 0096): a retry after an unknown
   * outcome — which is what a timeout on a field link is — finds the sample it
   * already created instead of filing a second one.
   */
  client_local_id?: string;
};

// Shapes returned by the API (a subset — enough for the beta screens).
export type SampleListRow = {
  id: string;
  name: string | null;
  collected_at: string;
  status: string;
  completeness_status: string | null;
  completeness_score: number | null;
  ai_confidence: number | null;
  /** Why the last analysis attempt failed. Null when it succeeded or none has run. */
  ai_error: string | null;
  /** When analysis last STARTED. A long-past value with status ai_processing is a run that died. */
  ai_attempted_at: string | null;
  geologist_confidence: number | null;
  confidence_score: number | null;
  area_id: string;
  created_at: string;
};

export type Bilingual = { en: string; so: string };
export type AssessmentConclusion = { id: string; kind: string; statement: string; statement_so: string | null; is_interpretation: boolean; confidence: number | null };
export type AssessmentEvidence = { id: string; source: string; ev_type: string; statement: string; statement_so: string | null; is_observation: boolean; tier: string | null; quality: number | null };
export type AssessmentEdge = { conclusion_id: string; evidence_id: string; polarity: string; contribution: number | null; effective_weight: number | null };
export type GeoAssessment = {
  id: string;
  overall_confidence: number | null;
  status: string;
  created_at: string;
  report: {
    headline?: Bilingual;
    simpleSummary?: Bilingual;
    opportunity?: "high" | "moderate" | "low" | "none";
    interpretation?: {
      whatItIs?: Bilingual; commonlyHosts?: Bilingual; lookForNext?: Bilingual;
      whyItMatters?: Bilingual; environment?: Bilingual;
    };
    uncertainties?: Bilingual[];
    missingInformation?: Bilingual[];
    recommendations?: Array<{ action: string; actionSo?: string; scaleM?: number; flagged?: boolean }>;
  } | null;
  assessment_conclusion: AssessmentConclusion[];
  assessment_evidence: AssessmentEvidence[];
  assessment_edge: AssessmentEdge[];
};

// The geologist's binding review (decision + confidence + notes) and the discussion
// timeline — surfaced to the collector so review feedback actually reaches them.
export type SampleReview = {
  id: string;
  round_no: number;
  status: string;
  decision: string | null; // verify | needs_more_data | reject
  geologist_confidence: number | null;
  corrected_interpretation: string | null;
  review_notes: string | null;
  recommendation: string | null;
  reviewer_role: string | null;
  submitted_at: string | null;
};
export type DiscussionMsg = { id: string; author_role: string | null; body: string; created_at: string };

export type SampleDetail = SampleListRow & {
  field_observations: string | null;
  sample_location: Array<{ altitude_m: number | null; gps_accuracy_m: number | null; h3_cell: string; provenance: string }>;
  sample_media: Array<{ id: string; role: string; storage_path: string; thumb_path: string | null }>;
  rock_observation: Array<{ rock_class: string | null; texture: string | null; notes: string | null }>;
  mineral_observation: Array<{ mineral: string; confidence: number | null }>;
  alteration_observation: Array<{ alteration_type: string | null; intensity: string | null; notes: string | null }>;
  structural_measurement: Array<unknown>;
  assessment?: GeoAssessment | null;
  review?: SampleReview | null;
  discussion?: DiscussionMsg[];
};

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("You must be signed in.");
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function readBody(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { message: text };
  }
}

/** Upload one captured photo to storage and return its storage_path (owner beta
 *  reuses the existing scan-images bucket, namespaced under enterprise/). */
/**
 * A copy of the photo sized for upload. The ORIGINAL on the device is untouched.
 *
 * Two passes, because the resize has to know the real dimensions: an empty
 * action list makes ImageManipulator report width and height without
 * re-encoding, and only then can the LONG edge be the one that is capped.
 * Resizing by width alone — the first version of this — leaves a portrait
 * outcrop shot at nearly twice the intended pixels.
 */
export async function shrinkForUpload(uri: string): Promise<string> {
  try {
    const probed = await ImageManipulator.manipulateAsync(uri, []);
    const target = resizeTargetFor(probed.width, probed.height);
    // Already small enough. Re-encoding would cost detail and save nothing.
    if (!target) return uri;

    const shrunk = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: target }],
      { compress: UPLOAD_JPEG_QUALITY, format: ImageManipulator.SaveFormat.JPEG },
    );
    return shrunk?.uri ?? uri;
  } catch {
    // Resizing failed on this device or this file. Upload the original rather
    // than lose the observation — a large photo is a slow upload, but a missing
    // one is a lost outcrop.
    return uri;
  }
}

export async function uploadSampleMedia(uri: string, role: MediaRole): Promise<SampleMediaInput> {
  const user = await getAuthUserTimed();
  if (!user) throw new Error("You must be signed in.");

  const sendUri = await shrinkForUpload(uri);

  const base64 = await FileSystem.readAsStringAsync(sendUri, { encoding: FileSystem.EncodingType.Base64 });
  // scan-images Storage RLS requires the FIRST path segment to equal the user's
  // uid (scan_images_storage_insert_own / _select_own). Keep {userId} first, then
  // namespace enterprise media under it so both upload and signed-URL read pass.
  const path = `${user.id}/enterprise/${Date.now()}-${role}.jpg`;
  const { error } = await supabase.storage
    .from("scan-images")
    .upload(path, decode(base64), { contentType: "image/jpeg", upsert: true });
  if (error) throw new Error(`Photo upload failed: ${error.message}`);
  return { role, storage_path: path };
}

/**
 * DELETE /enterprise-samples/:id — the collector clears their own sample.
 *
 * Soft delete on the server: the row survives so audit history and any
 * assessment stay coherent, while every read path stops returning it. The
 * stored photos ARE removed, because "deleted" that leaves megabytes behind is
 * not what anyone means by it.
 */
export async function deleteSample(id: string): Promise<void> {
  const res = await fetch(`${FUNCTIONS_URL}/enterprise-samples/${id}`, {
    method: "DELETE",
    headers: await authHeader(),
  });
  if (!res.ok) {
    const body = await readBody(res);
    throw new Error(body?.detail || body?.message || body?.error || `Delete failed (${res.status})`);
  }
}

/** POST /enterprise-samples — create a sample. Returns the created detail. */
export async function submitSample(input: NewSampleInput): Promise<{ sample_id: string; sample: SampleDetail }> {
  const res = await fetch(`${FUNCTIONS_URL}/enterprise-samples`, {
    method: "POST",
    headers: await authHeader(),
    body: JSON.stringify(input),
  });
  const body = await readBody(res);
  if (!res.ok) throw new Error(body?.detail || body?.message || body?.error || `Submit failed (${res.status})`);
  return body;
}

// Statuses after a geologist has reached a final decision — the sample is locked
// and the collector can no longer edit it. Everything before that (draft → …→
// awaiting_review, and needs_more_data) stays editable. Mirrors the edit_sample
// RPC gate (migration 0080); the server is still the authority.
const LOCKED_STATUSES = new Set(["verified", "rejected"]);

/** Whether the collector may still edit + re-submit this sample (pre-review). */
export function sampleIsEditable(status: string | null | undefined): boolean {
  return !!status && !LOCKED_STATUSES.has(status);
}

/** PUT /enterprise-samples/:id — edit a collected sample and re-submit it. Only
 *  allowed before a geologist reviews it; triggers a fresh AI analysis server-side. */
export async function editSample(id: string, input: NewSampleInput): Promise<{ sample_id: string; revision_no: number; sample: SampleDetail }> {
  const res = await fetch(`${FUNCTIONS_URL}/enterprise-samples/${id}`, {
    method: "PUT",
    headers: await authHeader(),
    body: JSON.stringify(input),
  });
  const body = await readBody(res);
  if (!res.ok) throw new Error(body?.detail || body?.message || body?.error || `Edit failed (${res.status})`);
  return body;
}

/** GET /enterprise-samples — the caller's own samples (RLS-scoped, newest first). */
/**
 * The caller's samples, optionally one workflow's worth.
 *
 * My Samples passes `personal`. Filtered on the SERVER: a screen that fetched
 * both and hid one would still have pulled a mission's evidence down into a
 * personal collection, and the hiding is the kind of thing the next list forgets.
 */
export async function listSamples(origin?: "personal" | "exploration"): Promise<SampleListRow[]> {
  const qs = origin ? `?origin=${origin}` : "";
  const res = await fetch(`${FUNCTIONS_URL}/enterprise-samples${qs}`, { headers: await authHeader() });
  const body = await readBody(res);
  if (!res.ok) throw new Error(body?.message || body?.error || `Load failed (${res.status})`);
  return body.samples ?? [];
}

/** POST /enterprise-samples/:id — force a fresh AI re-analysis (picks up newly
 *  loaded data). Runs in the background; refresh the sample shortly after. */
export async function reanalyzeSample(id: string): Promise<void> {
  const res = await fetch(`${FUNCTIONS_URL}/enterprise-samples/${id}`, { method: "POST", headers: await authHeader() });
  const body = await readBody(res);
  if (!res.ok) throw new Error(body?.detail || body?.message || body?.error || `Re-analyze failed (${res.status})`);
}

/** GET /enterprise-samples/:id — one sample with nested detail (RLS-scoped). */
export async function getSample(id: string): Promise<SampleDetail> {
  const res = await fetch(`${FUNCTIONS_URL}/enterprise-samples/${id}`, { headers: await authHeader() });
  const body = await readBody(res);
  if (res.status === 404) throw new Error("Sample not found.");
  if (!res.ok) throw new Error(body?.message || body?.error || `Load failed (${res.status})`);
  return body;
}

// ── Phase 6 (Solo→Team shared-targeting): structured evidence ───────────────
// The same five categories Solo's own User Geological Evidence form uses
// (mobile/lib/field/structuredEvidenceTypes.ts) — attached to an ALREADY
// SUBMITTED sample, because lab results in particular routinely arrive days
// after the field visit. Direct RPC calls (not the enterprise-samples Edge
// Function), same pattern lib/enterprise/missions.ts already uses.

export type StructuredEvidenceType = "assay" | "geophysics" | "mapping" | "remote_sensing" | "field_observation";
export type EvidenceVerificationStatus = "user_reported" | "expert_verified" | "lab_verified";

export type StructuredEvidence = {
  id: string;
  sample_id: string;
  evidence_type: StructuredEvidenceType;
  payload: Record<string, unknown>;
  /**
   * Server-authoritative — see add_sample_structured_evidence (0129): a
   * `lab_verified` claim with no explicit lab_accredited=true is downgraded
   * to `expert_verified` before this row is ever written. What you read back
   * here is always what actually happened, never what the client asked for.
   */
  verification_status: EvidenceVerificationStatus;
  lab_accredited: boolean;
  notes: string | null;
  created_at: string;
};

export async function fetchSampleStructuredEvidence(sampleId: string): Promise<StructuredEvidence[]> {
  const { data, error } = await supabase.schema("enterprise")
    .from("sample_structured_evidence")
    .select("id,sample_id,evidence_type,payload,verification_status,lab_accredited,notes,created_at")
    .eq("sample_id", sampleId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as StructuredEvidence[];
}

/**
 * `verificationStatus` is what the collector CLAIMS; the server only ever
 * honors `lab_verified` when `labAccredited` is also explicitly true — never
 * inferred from a lab name or a result being present.
 */
export async function addSampleStructuredEvidence(
  sampleId: string,
  evidenceType: StructuredEvidenceType,
  payload: Record<string, unknown>,
  opts: { verificationStatus?: EvidenceVerificationStatus; labAccredited?: boolean; notes?: string } = {},
): Promise<string> {
  const { data, error } = await supabase.schema("enterprise").rpc("add_sample_structured_evidence", {
    p_sample: sampleId,
    p_evidence_type: evidenceType,
    p_payload: payload,
    p_verification_status: opts.verificationStatus ?? "user_reported",
    p_lab_accredited: opts.labAccredited ?? false,
    p_notes: opts.notes ?? null,
  });
  if (error) throw error;
  return data as string;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("gps timeout")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Capture the current GPS fix for a new sample. Robust against the "spinner that
 * never stops": it uses a fast last-known fix first, then races a fresh reading
 * against a 15 s timeout (High, not Highest — Highest can hang indoors/cold-start),
 * and always resolves (best available or null) so the UI never gets stuck.
 */
export async function captureSampleLocation(): Promise<{ lat: number; lng: number; gps_accuracy_m?: number } | null> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== "granted") return null;

  let best: { lat: number; lng: number; acc?: number | null } | null = null;

  // 1) Instant provisional fix from cache so the UI shows something immediately.
  try {
    const last = await Location.getLastKnownPositionAsync({ maxAge: 60000 });
    if (last) best = { lat: last.coords.latitude, lng: last.coords.longitude, acc: last.coords.accuracy };
  } catch { /* ignore */ }

  // 2) Fresh reading, but never hang — cap at 15 s.
  try {
    const fresh = await withTimeout(
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      15000,
    );
    if (fresh) best = { lat: fresh.coords.latitude, lng: fresh.coords.longitude, acc: fresh.coords.accuracy };
  } catch { /* keep last-known if we have it */ }

  if (!best) return null;
  // Recorded to a tenth of a metre, not rounded to whole ones: a sample taken on
  // a ±1.4 m fix and one taken on a ±2.4 m fix are different records, and the
  // accuracy travels with the sample precisely so a reviewer can tell.
  return {
    lat: best.lat,
    lng: best.lng,
    gps_accuracy_m: best.acc != null ? Math.round(best.acc * 10) / 10 : undefined,
  };
}

// Enterprise Sample Submission API client (Sprint 4.2 — owner beta).
//
// Thin wrapper over the `enterprise-samples` Edge Function. It only carries the
// signed-in user's JWT (same pattern as scanUpload/goldVerification); it never
// touches payment or Stripe keys. Server-side, resolveActor re-verifies the JWT
// and requireEnterprise gates access to the owner allowlist, so this client
// stays deliberately dumb — validation and authorization are enforced there.
import { decode } from "base64-arraybuffer";
import * as FileSystem from "expo-file-system";
import * as Location from "expo-location";
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
  observations?: {
    rock?: { rock_class?: string; texture?: string; notes?: string } | null;
    minerals?: MineralObservationInput[];
  };
  media?: SampleMediaInput[];
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
    uncertainties?: Bilingual[];
    missingInformation?: Bilingual[];
    recommendations?: Array<{ action: string; actionSo?: string; scaleM?: number; flagged?: boolean }>;
  } | null;
  assessment_conclusion: AssessmentConclusion[];
  assessment_evidence: AssessmentEvidence[];
  assessment_edge: AssessmentEdge[];
};

export type SampleDetail = SampleListRow & {
  field_observations: string | null;
  sample_location: Array<{ altitude_m: number | null; gps_accuracy_m: number | null; h3_cell: string; provenance: string }>;
  sample_media: Array<{ id: string; role: string; storage_path: string; thumb_path: string | null }>;
  rock_observation: Array<{ rock_class: string | null; texture: string | null; notes: string | null }>;
  mineral_observation: Array<{ mineral: string; confidence: number | null }>;
  alteration_observation: Array<{ alteration_type: string | null; intensity: string | null; notes: string | null }>;
  structural_measurement: Array<unknown>;
  assessment?: GeoAssessment | null;
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
export async function uploadSampleMedia(uri: string, role: MediaRole): Promise<SampleMediaInput> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("You must be signed in.");
  const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
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

/** POST /enterprise-samples — create a sample. Returns the created detail. */
export async function submitSample(input: NewSampleInput): Promise<{ sample_id: string; sample: SampleDetail }> {
  const res = await fetch(`${FUNCTIONS_URL}/enterprise-samples`, {
    method: "POST",
    headers: await authHeader(),
    body: JSON.stringify(input),
  });
  const body = await readBody(res);
  if (!res.ok) throw new Error(body?.message || body?.error || `Submit failed (${res.status})`);
  return body;
}

/** GET /enterprise-samples — the caller's own samples (RLS-scoped, newest first). */
export async function listSamples(): Promise<SampleListRow[]> {
  const res = await fetch(`${FUNCTIONS_URL}/enterprise-samples`, { headers: await authHeader() });
  const body = await readBody(res);
  if (!res.ok) throw new Error(body?.message || body?.error || `Load failed (${res.status})`);
  return body.samples ?? [];
}

/** GET /enterprise-samples/:id — one sample with nested detail (RLS-scoped). */
export async function getSample(id: string): Promise<SampleDetail> {
  const res = await fetch(`${FUNCTIONS_URL}/enterprise-samples/${id}`, { headers: await authHeader() });
  const body = await readBody(res);
  if (res.status === 404) throw new Error("Sample not found.");
  if (!res.ok) throw new Error(body?.message || body?.error || `Load failed (${res.status})`);
  return body;
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
  return { lat: best.lat, lng: best.lng, gps_accuracy_m: best.acc != null ? Math.round(best.acc) : undefined };
}

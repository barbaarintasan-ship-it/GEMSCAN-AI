// GIE stage 2 — VISION (Sprint 4.3 S3).
//
// Gemini reads the sample photographs and reports ONLY what is visually
// observable (texture, colour, visible minerals, veining, alteration, weathering,
// structure) — it does NOT identify the deposit or guess the locality. These
// become `visual` OBSERVATION nodes (facts about the image), tier `ai_visual`
// (low base weight), so they inform but never dominate the reasoning.
//
// The AI call is injected (VisionDeps) so buildVisionPrompt / parseVisionResponse /
// visualEvidence stay pure and unit-testable without a key or network.
import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";
import type { EvidenceInput } from "./types.ts";

const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest";

export type VisualAspect =
  | "texture" | "color" | "mineral" | "vein" | "alteration" | "weathering" | "structure" | "other";
const ASPECTS: VisualAspect[] = ["texture", "color", "mineral", "vein", "alteration", "weathering", "structure", "other"];

export interface VisualObservation {
  statement: string;    // English
  statementSo: string;  // Somali
  aspect: VisualAspect;
  clarity: number; // 0..1 — how clearly it is visible (image-limited)
}

export interface VisionImage { base64: string; mimeType: string }

export interface VisionDeps {
  fetchImageBase64: (url: string) => Promise<VisionImage>;
  // Returns the model's raw text (expected to be JSON per the prompt).
  generate: (prompt: string, images: VisionImage[]) => Promise<string>;
}

// ── Pure: prompt ────────────────────────────────────────────────────────────
export function buildVisionPrompt(): string {
  return [
    "You are an exploration geologist examining field photographs of a rock/mineral specimen.",
    "Report ONLY what is directly visible. Do NOT identify the deposit, the locality, or the",
    "commodity, and do NOT infer genesis — those are decided later from other evidence.",
    "List each distinct visual observation (grain size/texture, colour, visible mineral phases,",
    "veining, alteration coatings, weathering, fractures/structure).",
    "For each, give: a short factual statement in BOTH English (statement) and Somali",
    "(statement_so), an aspect, and a clarity score 0..1 reflecting how clearly it can be",
    "seen given the image quality.",
    'Output STRICT JSON only: {"observations":[{"statement":"...","statement_so":"...","aspect":"texture|color|mineral|vein|alteration|weathering|structure|other","clarity":0.0}]}',
    'If the images are too poor to observe anything, return {"observations":[]}.',
  ].join("\n");
}

// ── Pure: parse ─────────────────────────────────────────────────────────────
export function parseVisionResponse(text: string): VisualObservation[] {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  let obj: unknown;
  try { obj = JSON.parse(cleaned); } catch { return []; }
  const arr = Array.isArray(obj) ? obj : (obj as { observations?: unknown }).observations;
  if (!Array.isArray(arr)) return [];
  const out: VisualObservation[] = [];
  for (const raw of arr) {
    const r = raw as Record<string, unknown>;
    const statement = typeof r.statement === "string" ? r.statement.trim() : "";
    if (!statement) continue;
    const statementSo = typeof r.statement_so === "string" && r.statement_so.trim() ? r.statement_so.trim() : statement;
    const aspect = ASPECTS.includes(r.aspect as VisualAspect) ? (r.aspect as VisualAspect) : "other";
    const clarity = clamp01(typeof r.clarity === "number" ? r.clarity : Number(r.clarity));
    out.push({ statement, statementSo, aspect, clarity });
    if (out.length >= 24) break; // cap
  }
  return out;
}

// ── Pure: observations → evidence nodes ─────────────────────────────────────
// imageQuality (0..1) scales visual confidence — poor photos yield weaker evidence.
export function visualEvidence(obs: VisualObservation[], imageQuality = 1): EvidenceInput[] {
  const iq = clamp01(imageQuality);
  return obs.map((o) => ({
    source: "gemini_vision",
    evType: "visual",
    statement: o.statement,
    statementSo: o.statementSo,
    isObservation: true, // describing what is literally visible
    epistemic: "observed",
    tier: "ai_visual",
    quality: clamp01(o.clarity * iq),
    provenance: { source: "gemini_vision", aspect: o.aspect },
  }));
}

// ── Impure: run the vision call over image URLs ─────────────────────────────
/**
 * How much image the vision call may carry, in BYTES.
 *
 * THE COUNT WAS THE WRONG AXIS. An earlier fix capped this at six IMAGES,
 * reasoning that a sample with 27 photos was the problem. Production says
 * otherwise:
 *
 *     Qarka Qardhl        11 photos   6.94 MB each    failed
 *     Aaga Qardho          9 photos   7.16 MB each    failed
 *     Qardho buur u dhow  27 photos   5.04 MB each    failed
 *     Guri                 3 photos   4.42 MB each    FAILED
 *     Sample / Sample2     5 photos   0.10 MB each    fine
 *     Ma garanayo          2 photos   0.16 MB each    fine
 *
 * Three photos failed and five succeeded. What separates them is size, not
 * number: base64 inflates by a third, so six 7 MB photos is ~56 MB in a single
 * request — past Gemini's inline-payload limit and past what an Edge Function
 * can hold. The old app compressed to ~100 KB; the current one uploads the
 * sensor's full frame, which is why this began recently and why capping the
 * count did nothing.
 *
 * The budget is on the ENCODED total, because that is what actually goes on the
 * wire. Images are taken highest-quality-first until it is spent.
 */
export const MAX_VISION_BYTES = 12 * 1024 * 1024;

/**
 * A single image larger than this is skipped rather than allowed to consume the
 * whole budget. One enormous frame would otherwise crowd out four usable ones,
 * and the model gains more from several views than from one huge one.
 *
 * Measured on the ENCODED length, which is about a third larger than the file:
 * 8 MB here admits a photo of roughly 6 MB on disk. Past that a sample simply
 * gets no visual evidence, and its assessment rests on the geological providers
 * alone — degraded, which is the correct outcome, and never stranded.
 */
export const MAX_SINGLE_IMAGE_BYTES = 8 * 1024 * 1024;

/** A last guard on count, so a thousand thumbnails cannot each cost a round trip. */
export const MAX_VISION_IMAGES = 8;

export async function runVision(imageUrls: string[], deps: VisionDeps): Promise<VisualObservation[]> {
  if (imageUrls.length === 0) return [];

  // Sequential, not Promise.all: parallel fetches hold every image in memory at
  // once, which is the other half of what blew the ceiling. Fetching one at a
  // time also means an oversized image is discovered and dropped before the
  // next is pulled, so the peak is one image plus the kept set.
  const images: VisionImage[] = [];
  let bytes = 0;

  for (const u of imageUrls) {
    if (images.length >= MAX_VISION_IMAGES) break;

    let img: VisionImage;
    try {
      img = await deps.fetchImageBase64(u);
    } catch {
      // One dead signed URL must not cost the whole assessment. Vision is
      // enrichment; the geological providers still stand on their own.
      continue;
    }

    const size = img.base64.length;
    if (size > MAX_SINGLE_IMAGE_BYTES) continue;
    if (bytes + size > MAX_VISION_BYTES) {
      // Budget spent. Later images are lower quality anyway — the caller sorts
      // best-first — so stopping here costs the least.
      break;
    }

    images.push(img);
    bytes += size;
  }

  // Every photo was too large, or every fetch failed. Returning empty degrades
  // the assessment; throwing would strand the sample, which is the failure this
  // whole path exists to prevent.
  if (images.length === 0) return [];

  const text = await deps.generate(buildVisionPrompt(), images);
  return parseVisionResponse(text);
}

// ── Default deps: the real Gemini call (mirrors the consumer integration) ────
export const defaultVisionDeps: VisionDeps = {
  fetchImageBase64: async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`image fetch failed (${res.status})`);
    const mimeType = res.headers.get("content-type") ?? "image/jpeg";
    return { base64: encodeBase64(new Uint8Array(await res.arrayBuffer())), mimeType };
  },
  generate: async (prompt, images) => {
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("GEMINI_API_KEY not configured");
    const body = {
      contents: [{
        role: "user",
        parts: [{ text: prompt }, ...images.map((im) => ({ inline_data: { mime_type: im.mimeType, data: im.base64 } }))],
      }],
      generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
    };
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    );
    const raw = await res.json();
    if (!res.ok) throw new Error(raw?.error?.message ?? `Gemini API error (status ${res.status})`);
    return raw?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  },
};

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}

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
  statement: string;
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
    "For each, give: a short factual statement, an aspect, and a clarity score 0..1 reflecting",
    "how clearly it can be seen given the image quality.",
    'Output STRICT JSON only: {"observations":[{"statement":"...","aspect":"texture|color|mineral|vein|alteration|weathering|structure|other","clarity":0.0}]}',
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
    const aspect = ASPECTS.includes(r.aspect as VisualAspect) ? (r.aspect as VisualAspect) : "other";
    const clarity = clamp01(typeof r.clarity === "number" ? r.clarity : Number(r.clarity));
    out.push({ statement, aspect, clarity });
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
    isObservation: true, // describing what is literally visible
    tier: "ai_visual",
    quality: clamp01(o.clarity * iq),
    provenance: { source: "gemini_vision", aspect: o.aspect },
  }));
}

// ── Impure: run the vision call over image URLs ─────────────────────────────
export async function runVision(imageUrls: string[], deps: VisionDeps): Promise<VisualObservation[]> {
  if (imageUrls.length === 0) return [];
  const images = await Promise.all(imageUrls.map((u) => deps.fetchImageBase64(u)));
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

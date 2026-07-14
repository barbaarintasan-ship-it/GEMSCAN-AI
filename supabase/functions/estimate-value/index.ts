// Market-value estimation (additive, Gemini only).
//
// A SEPARATE step from identification — it never touches the orchestrate-scan
// ensemble. Given an already-identified label, Gemini returns an ESTIMATED USD
// value range for a typical specimen of that kind, plus rarity/collectibility
// flags used to decide whether to recommend an expert review. It is explicitly
// prompted to never present exact prices as fact.
//
// Fails soft: any missing key / error returns { available: false } and the app
// simply omits the valuation section.
import { corsHeaders } from "../_shared/cors.ts";

const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest";

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) return jsonResponse({ available: false, reason: "no_key" });

    const { label, confidence, lang } = (await req.json().catch(() => ({}))) as {
      label?: string;
      confidence?: number;
      lang?: string;
    };
    if (!label || typeof label !== "string") {
      return jsonResponse({ error: "label is required" }, 400);
    }
    const langLine =
      lang === "so"
        ? `Write the "qualityNote" field in clear, natural Somali.\n`
        : `Write the "qualityNote" field in English.\n`;

    const prompt =
      `You are a gemstone/mineral/coin/precious-metal market-valuation assistant.\n` +
      `A specimen has been identified (from photographs, not lab-tested) as: "${label}".\n` +
      (typeof confidence === "number" ? `Identification confidence: ${(confidence * 100).toFixed(0)}%.\n` : "") +
      `Estimate a realistic USD market value RANGE for a typical commercial specimen of this kind, ` +
      `considering species, typical size/quality/clarity/color/rarity and overall condition. ` +
      `NEVER present exact prices as fact — these are photograph-based estimates only.\n` +
      `If this kind of object is genuinely too variable or you cannot reasonably estimate, set lowConfidence true.\n` +
      langLine +
      `Respond with ONLY minified JSON of exactly this shape:\n` +
      `{"minUsd": number, "typicalUsd": number, "premiumUsd": number|null, ` +
      `"rarity": "common"|"uncommon"|"rare"|"very_rare", "collectible": boolean, ` +
      `"qualityNote": string, "lowConfidence": boolean}`;

    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
    };

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    );
    const raw = await res.json();
    if (!res.ok) return jsonResponse({ available: false, reason: raw?.error?.message ?? "gemini_error" });

    const text = raw?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const cleaned = text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
    const p = JSON.parse(cleaned);

    const num = (v: unknown): number | null => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const rarity = ["common", "uncommon", "rare", "very_rare"].includes(String(p.rarity))
      ? String(p.rarity)
      : "common";

    return jsonResponse({
      available: true,
      minUsd: num(p.minUsd),
      typicalUsd: num(p.typicalUsd),
      premiumUsd: num(p.premiumUsd),
      rarity,
      collectible: p.collectible === true,
      qualityNote: String(p.qualityNote ?? ""),
      lowConfidence: p.lowConfidence === true,
    });
  } catch (err) {
    return jsonResponse({ available: false, reason: (err as Error).message });
  }
});

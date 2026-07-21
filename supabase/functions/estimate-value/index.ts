// Market-value estimation (additive, Gemini only).
//
// A SEPARATE step from identification — it never touches the orchestrate-scan
// ensemble. Given an already-identified label, Gemini returns an ESTIMATED USD
// market price RANGE expressed in the correct pricing UNIT (per gram for metals,
// per carat for cut gems, per specimen otherwise) — it never assumes the weight
// of the pictured object — plus rarity/collectibility flags used to decide
// whether to recommend an expert review. It is explicitly prompted to never
// present exact prices as fact.
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
      `You are a gemstone / mineral / coin / precious-metal market-valuation assistant.\n` +
      `An object has been identified from PHOTOGRAPHS ONLY (not lab-tested, not weighed) as: "${label}".\n` +
      (typeof confidence === "number" ? `Identification confidence: ${(confidence * 100).toFixed(0)}%.\n` : "") +
      `CRITICAL RULES:\n` +
      `- You CANNOT see weight, carat, or dimensions in a photograph. NEVER invent grams, carats, dimensions, ` +
      `or a single total value for the pictured object.\n` +
      `- Price by the correct MARKET UNIT for this material and set "unit" accordingly:\n` +
      `  * Gold / silver / platinum / other precious metal → "gram". Price per gram. If a purity is standard or ` +
      `visibly implied (24K/22K/18K/14K, 925 silver, etc.) set "purity" to it, else null. Do NOT estimate a total.\n` +
      `  * Cut / faceted / polished gemstone (diamond, ruby, sapphire, emerald, tanzanite, spinel, opal, etc.) → ` +
      `"carat". Price per carat. Never estimate the whole stone's total value — carat weight is unknown.\n` +
      `  * Rough stone, mineral specimen, collectible, coin or artifact normally sold as a piece → "specimen". ` +
      `Price per specimen (per piece). Use a per-kilogram figure ONLY if that is the accepted market standard for ` +
      `that material, and still report "unit":"specimen" with the kg basis noted in "qualityNote".\n` +
      `- ALWAYS give a realistic price RANGE (minUsd..maxUsd) — NEVER a single fixed number. "typicalUsd" is an ` +
      `optional midpoint or null.\n` +
      `- VALUE THE ITEM HONESTLY AT ITS REAL, CURRENT MARKET PRICE. For high-value items (diamond, ruby, sapphire, ` +
      `emerald, gold, native gold, rare/ancient coin, antique or archaeological artifact, etc.) give the genuine ` +
      `real-world market price — do NOT lowball, dismiss, or downplay it.\n` +
      `- Assume the item IS the genuine identified item and price a GENUINE, AUTHENTIC example of it. You cannot ` +
      `verify authenticity from a photo, so frame "qualityNote" conditionally — e.g. "If genuine, a piece like this ` +
      `is worth roughly this today." This holds even if the photo may have come from the internet: value the ITEM ` +
      `as identified, not the user's situation.\n` +
      `- Do NOT add plausibility, geographic, "probably fake", or "unlikely to be found here / in your country" ` +
      `caveats, and never comment on whether the user could realistically own it. Only value the item.\n` +
      `- Do NOT set lowConfidence just because the item is rare, expensive, or seems unlikely — set it ONLY if the ` +
      `item TYPE is genuinely too variable to price at all.\n` +
      langLine +
      `Respond with ONLY minified JSON of exactly this shape:\n` +
      `{"unit": "gram"|"carat"|"specimen", "purity": string|null, "minUsd": number, "maxUsd": number, ` +
      `"typicalUsd": number|null, "rarity": "common"|"uncommon"|"rare"|"very_rare", "collectible": boolean, ` +
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
    const unit = ["gram", "carat", "specimen"].includes(String(p.unit)) ? String(p.unit) : "specimen";
    const purity = p.purity != null && String(p.purity).trim() !== "" ? String(p.purity).trim() : null;

    return jsonResponse({
      available: true,
      unit,
      purity,
      minUsd: num(p.minUsd),
      maxUsd: num(p.maxUsd),
      typicalUsd: num(p.typicalUsd),
      rarity,
      collectible: p.collectible === true,
      qualityNote: String(p.qualityNote ?? ""),
      lowConfidence: p.lowConfidence === true,
    });
  } catch (err) {
    return jsonResponse({ available: false, reason: (err as Error).message });
  }
});

// STAGE 1 · LEVEL 2 — Cloud object pre-check (Gemini only).
//
// A CHEAP gate that runs before the full identification ensemble. It receives
// ONE low-resolution image (≤512px, sent inline as base64) and asks Gemini a
// single yes/no-style question: is this a gemstone / mineral / rock / gold /
// silver / jewelry / coin / historical artifact — or NOT_SUPPORTED? It does NOT
// identify the specimen. If the object is unsupported we stop here and NEVER
// call OpenAI or Claude, keeping API cost minimal.
//
// Fails OPEN: any missing key / API error / parse failure returns supported=true
// so a pre-check glitch can never block a legitimate scan. Only a confident
// NOT_SUPPORTED verdict rejects.
import { corsHeaders } from "../_shared/cors.ts";

const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest";

const PROMPT = `Determine ONLY whether the main object in this image is one of the following categories:
gemstone, mineral, rock, gold, silver, jewelry, coin, historical artifact.
If it is NOT one of these categories (for example a person, hand, face, food, animal, laptop, chair, room, sky, document or random clutter), it is not supported.
Do NOT identify or name the gemstone yet — only classify the category.
Respond with ONLY minified JSON of exactly this shape:
{"supported": boolean, "category": string}
Set "category" to one of the listed categories when supported, or "not_supported" when not.`;

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function parseVerdict(text: string): { supported: boolean; category: string | null } {
  try {
    const cleaned = text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
    const p = JSON.parse(cleaned);
    const category = String(p.category ?? "").toLowerCase().trim();
    const supported = p.supported === true && category !== "" && category !== "not_supported";
    return { supported, category: supported ? category : null };
  } catch {
    // Model answered in prose despite instructions.
    if (/not[_\s-]?supported/i.test(text)) return { supported: false, category: null };
    return { supported: true, category: null };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  try {
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) {
      return jsonResponse({ supported: true, category: null, reason: "no_key" });
    }

    const { imageBase64, mimeType } = (await req.json().catch(() => ({}))) as {
      imageBase64?: string;
      mimeType?: string;
    };
    if (!imageBase64 || typeof imageBase64 !== "string") {
      return jsonResponse({ error: "imageBase64 is required" }, 400);
    }

    const body = {
      contents: [
        {
          role: "user",
          parts: [
            { text: PROMPT },
            { inline_data: { mime_type: mimeType ?? "image/jpeg", data: imageBase64 } },
          ],
        },
      ],
      generationConfig: { temperature: 0, responseMimeType: "application/json" },
    };

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    );
    const raw = await res.json();
    if (!res.ok) {
      // Fail open on any Gemini error — never block a scan on a pre-check glitch.
      return jsonResponse({ supported: true, category: null, reason: raw?.error?.message ?? "gemini_error" });
    }
    const text = raw?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    return jsonResponse(parseVerdict(text));
  } catch (err) {
    return jsonResponse({ supported: true, category: null, reason: (err as Error).message });
  }
});

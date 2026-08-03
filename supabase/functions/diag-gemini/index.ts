// TEMPORARY diagnostic — checks whether the configured GEMINI_API_KEY + model
// can actually reach the Gemini API, to root-cause a "scans identify nothing"
// outage. Token-gated so it can't be abused while deployed. DELETE after use.
import { corsHeaders } from "../_shared/cors.ts";

const TOKEN = "c738abc509db78db";
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = new URL(req.url);
  if (url.searchParams.get("token") !== TOKEN) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: corsHeaders });
  }

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  const out: Record<string, unknown> = {
    hasKey: Boolean(apiKey),
    keyLength: apiKey ? apiKey.length : 0,
    model: GEMINI_MODEL,
  };

  if (!apiKey) {
    return new Response(JSON.stringify(out), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  // A 1x1 red PNG, base64 — replicates the real scan's multimodal payload
  // (image + text) WITH responseMimeType application/json, which the plain
  // text probe above did not exercise.
  const onePxPng =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  async function probe(label: string, body: unknown) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const raw = await res.json().catch(() => null);
      out[label] = {
        httpStatus: res.status,
        ok: res.ok,
        geminiError: raw?.error?.message ?? null,
        geminiErrorStatus: raw?.error?.status ?? null,
        sampleText: raw?.candidates?.[0]?.content?.parts?.[0]?.text ?? null,
      };
    } catch (err) {
      out[label] = { fetchError: (err as Error).message };
    }
  }

  await probe("textPlain", {
    contents: [{ role: "user", parts: [{ text: "Reply with the single word OK." }] }],
    generationConfig: { temperature: 0 },
  });
  await probe("textJson", {
    contents: [{ role: "user", parts: [{ text: 'Reply with JSON {"ok":true}' }] }],
    generationConfig: { temperature: 0, responseMimeType: "application/json" },
  });
  await probe("visionJson", {
    contents: [
      {
        role: "user",
        parts: [
          { text: 'Describe this image. Reply as JSON {"desc":string}' },
          { inline_data: { mime_type: "image/png", data: onePxPng } },
        ],
      },
    ],
    generationConfig: { temperature: 0, responseMimeType: "application/json" },
  });

  return new Response(JSON.stringify(out), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});

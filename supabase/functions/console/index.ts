// console — serves the LuulScan Review Console single-page app.
//
// Why an Edge Function and not a plain storage URL: Supabase's public Storage
// endpoint deliberately serves HTML as `text/plain` (anti-phishing), so an
// index.html opened directly shows its source instead of rendering. This function
// fetches the built index.html from the `review-console` bucket and re-serves it
// with `text/html`, so the browser renders the app. The JS/CSS assets it references
// load fine straight from public Storage (those keep their correct types).
//
// Public page → verify_jwt = false (see config.toml). No secrets here: the app's
// own Supabase login + RLS still gate every piece of data it shows.
const INDEX_URL =
  "https://znqkzgswvhbkhxldbbld.supabase.co/storage/v1/object/public/review-console/index.html";

Deno.serve(async () => {
  try {
    const res = await fetch(INDEX_URL, { cache: "no-store" });
    if (!res.ok) {
      return new Response(`Console shell not found (storage ${res.status}).`, {
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    const html = await res.text();
    return new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // Short cache so a re-uploaded shell (new asset hashes) is picked up quickly.
        "cache-control": "public, max-age=60",
      },
    });
  } catch (err) {
    return new Response(`Console error: ${(err as Error).message}`, {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
});

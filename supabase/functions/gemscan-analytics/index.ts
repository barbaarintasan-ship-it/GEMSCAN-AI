// gemscan-analytics
//
// Read-only analytics for the WordPress dashboard. Secret-authenticated
// (ACTIVATION_SECRET, same as activate-subscription) because the caller is the
// website, not a logged-in app user. Returns one JSON blob of usage /
// subscription / credit aggregates computed by the gemscan_analytics() SQL
// function (migration 0006). No writes, no payment data.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders } from "../_shared/cors.ts";

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const secret = Deno.env.get("ACTIVATION_SECRET");
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!secret || String(body.secret ?? "") !== secret) {
      return json({ error: "unauthorized" }, 401);
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data, error } = await admin.rpc("gemscan_analytics");
    if (error) return json({ error: error.message }, 500);

    return json({ ok: true, analytics: data });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});

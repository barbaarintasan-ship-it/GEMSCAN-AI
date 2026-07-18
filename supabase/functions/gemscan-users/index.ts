// gemscan-users
//
// Full registrant list for the WordPress admin "Registered Users" page.
// Secret-authenticated (ACTIVATION_SECRET, same as activate-subscription /
// gemscan-analytics) because the caller is the website, not a logged-in app
// user. Returns a paginated page of users (email, joined, plan, scan counts)
// via the gemscan_users_list() SQL function (migration 0007). Read-only.
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

    const limit = Math.min(Math.max(Number(body.limit ?? 50), 1), 200);
    const offset = Math.max(Number(body.offset ?? 0), 0);
    const search = String(body.search ?? "").slice(0, 120);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data, error } = await admin.rpc("gemscan_users_list", {
      p_limit: limit,
      p_offset: offset,
      p_search: search,
    });
    if (error) return json({ error: error.message }, 500);

    return json({ ok: true, data });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});

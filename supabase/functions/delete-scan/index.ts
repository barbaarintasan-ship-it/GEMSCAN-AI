// delete-scan
//
// Permanently deletes ONE scan the caller owns, plus its Storage images, so a
// user can prune items from "My Collection" (history.tsx). Mirrors
// delete-account's pattern: the client can't delete Storage objects or scan
// rows directly (no such RLS policy — see migration 0002), so this runs as
// service_role after verifying ownership strictly from the caller's own JWT.
//
// Deleting the scan row cascades every dependent row (scan_images,
// scan_ai_responses, scan_candidates, scan_feedback, and the
// diamond/gold/artifact verification + purchase tables — all FK'd to scans
// with ON DELETE CASCADE). Storage files are the one thing that doesn't
// cascade, so they're removed explicitly first.
//
// Request:  POST, Authorization: Bearer <user JWT>, body: { scanId: string }
// Response: { success: true }
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders } from "../_shared/cors.ts";
import { logError } from "../_shared/logger.ts";

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    const body = await req.json().catch(() => ({}));
    const scanId = body?.scanId;
    if (!scanId || typeof scanId !== "string") {
      return json({ error: "Missing or invalid scanId" }, 400);
    }

    // 1) Identify the caller strictly from their own JWT.
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser();
    if (userError || !user) return json({ error: "Invalid or expired session" }, 401);

    // 2) Admin (service-role) client for the storage purge + cascade delete.
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    // 3) Ownership check — the scan must belong to THIS user. Prevents a
    //    caller from deleting another user's scan by guessing an id.
    const { data: scanRow, error: scanErr } = await admin
      .from("scans")
      .select("id")
      .eq("id", scanId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (scanErr) {
      logError("delete-scan:lookup", scanErr, { scanId });
      return json({ error: "Could not look up the scan" }, 500);
    }
    if (!scanRow) {
      // Either it doesn't exist or it isn't this user's — same response either
      // way, so ownership can't be probed.
      return json({ error: "Scan not found" }, 404);
    }

    // 4) Remove Storage files (best-effort — never block the delete on this).
    //    Two sources: the original/processed paths recorded on scan_images,
    //    plus any verification photos under `${user.id}/${scanId}/verification/`
    //    (those live only in the verification tables' image_paths jsonb, so
    //    they're gathered by listing the folder rather than a column read).
    try {
      const paths: string[] = [];

      const { data: imgs } = await admin
        .from("scan_images")
        .select("original_storage_path, processed_storage_path")
        .eq("scan_id", scanId);
      for (const r of imgs ?? []) {
        const row = r as { original_storage_path?: string; processed_storage_path?: string };
        if (row.original_storage_path) paths.push(row.original_storage_path);
        if (row.processed_storage_path) paths.push(row.processed_storage_path);
      }

      const { data: verificationFiles } = await admin.storage
        .from("scan-images")
        .list(`${user.id}/${scanId}/verification`);
      for (const f of verificationFiles ?? []) {
        if (f?.name) paths.push(`${user.id}/${scanId}/verification/${f.name}`);
      }

      if (paths.length > 0) {
        await admin.storage.from("scan-images").remove(paths);
      }
    } catch (storageErr) {
      logError("delete-scan:storage", storageErr, { scanId });
      // Continue — orphaned files are swept by the unlinked-image lifecycle
      // policy; the scan row must still be deleted.
    }

    // 5) Delete the scan row — cascades every dependent row.
    const { error: delError } = await admin.from("scans").delete().eq("id", scanId).eq("user_id", user.id);
    if (delError) {
      logError("delete-scan:delete", delError, { scanId });
      return json({ error: "Could not delete the scan. Please try again." }, 500);
    }

    return json({ success: true });
  } catch (err) {
    logError("delete-scan", err);
    return json({ error: (err as Error).message }, 500);
  }
});

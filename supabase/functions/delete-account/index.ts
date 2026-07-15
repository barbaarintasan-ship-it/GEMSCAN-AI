// delete-account
//
// Permanently deletes the calling user's account and all associated data, so
// the app satisfies Apple App Store Guideline 5.1.1(v) (any app that lets a
// user create an account must let them delete it from within the app) and the
// equivalent Google Play data-deletion requirement.
//
// Flow:
//   1. Identify the caller from THEIR OWN JWT (never a passed-in user id).
//   2. With the service-role key, remove the user's Storage files (the one
//      thing that does not FK-cascade) and then delete the auth user. Every
//      DB table references auth.users with ON DELETE CASCADE, so scans,
//      scan_images, subscriptions, feedback, etc. are removed automatically.
//
// Request:  POST, Authorization: Bearer <user JWT>
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

    // 2) Admin (service-role) client to purge data + delete the auth record.
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    // 2a) Remove the user's Storage files (paths are `${user.id}/${scanId}/…`,
    //     stored on scan_images). Best-effort: never block deletion on this.
    try {
      const { data: scanRows } = await admin
        .from("scans")
        .select("id")
        .eq("user_id", user.id);
      const scanIds = (scanRows ?? []).map((r: { id: string }) => r.id);
      if (scanIds.length > 0) {
        const { data: imgs } = await admin
          .from("scan_images")
          .select("original_storage_path, processed_storage_path")
          .in("scan_id", scanIds);
        const paths = (imgs ?? [])
          .flatMap((r: { original_storage_path?: string; processed_storage_path?: string }) => [
            r.original_storage_path,
            r.processed_storage_path,
          ])
          .filter((p): p is string => Boolean(p));
        if (paths.length > 0) {
          await admin.storage.from("scan-images").remove(paths);
        }
      }
    } catch (storageErr) {
      logError("delete-account:storage", storageErr);
      // Continue — the account must still be deleted even if file cleanup fails.
    }

    // 2b) Delete the auth user — cascades every DB row referencing them.
    const { error: delError } = await admin.auth.admin.deleteUser(user.id);
    if (delError) {
      logError("delete-account:deleteUser", delError);
      return json({ error: "Could not delete the account. Please try again." }, 500);
    }

    return json({ success: true });
  } catch (err) {
    logError("delete-account", err);
    return json({ error: (err as Error).message }, 500);
  }
});

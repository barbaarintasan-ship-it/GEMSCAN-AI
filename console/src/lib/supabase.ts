// Supabase client for the Review Console. Auth + reads live on the same project as
// the mobile app; the console queries the `enterprise` and `geo` schemas via
// `.schema(...)`. The anon/publishable key is public (RLS enforces access).
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const functionsUrl = import.meta.env.VITE_SUPABASE_FUNCTIONS_URL as string;

if (!url || !anon) {
  throw new Error("Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (see .env.example).");
}

export const supabase = createClient(url, anon, {
  auth: { persistSession: true, autoRefreshToken: true },
});

export const FUNCTIONS_URL = functionsUrl ?? url.replace(".supabase.co", ".functions.supabase.co");

/** Call an Edge Function with the current user's JWT. */
export async function callFunction(path: string, body: unknown): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(`${FUNCTIONS_URL}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

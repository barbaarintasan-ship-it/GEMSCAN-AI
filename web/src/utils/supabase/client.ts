// Browser-side Supabase client (Client Components). Shares the auth session
// with the server via cookies managed by @supabase/ssr.
import { createBrowserClient } from "@supabase/ssr";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

export function createClient() {
  return createBrowserClient(supabaseUrl, supabaseKey);
}

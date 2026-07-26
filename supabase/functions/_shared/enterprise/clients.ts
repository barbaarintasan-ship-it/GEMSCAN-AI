// Enterprise middleware — CLIENT FACTORIES.
//
// Two Supabase clients, both bound to the `enterprise` schema by default (the
// schema is exposed to PostgREST; see config.toml [api].schemas). Override the
// schema per call with `.schema("geo")` / `.schema("public")` when needed.
//
//   serviceClient() — service role, BYPASSRLS. Use ONLY after a request has been
//                     authorized; it can read/write anything, so never hand its
//                     rows back to a caller without applying the caller's own
//                     visibility rules. All enterprise WRITES go through this.
//   userClient(req) — carries the caller's JWT, so every query is RLS-enforced
//                     as that user. Use for reads that must respect row security.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// Schema-agnostic client type — our clients default to the `enterprise` schema
// (not "public"), and callers may override per query, so we relax the schema
// generic rather than pin it to a literal.
export type DbClient = SupabaseClient<any, any>;

export const ENTERPRISE_SCHEMA = "enterprise";

function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

export function serviceClient(schema: string = ENTERPRISE_SCHEMA): DbClient {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    db: { schema },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function userClient(req: Request, schema: string = ENTERPRISE_SCHEMA): DbClient {
  const authHeader = req.headers.get("Authorization") ?? "";
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_ANON_KEY"), {
    db: { schema },
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

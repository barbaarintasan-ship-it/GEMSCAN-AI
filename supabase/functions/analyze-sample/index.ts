// Edge Function entry for the Geological Intelligence Engine. verify_jwt=false
// (config.toml) — called server-to-server with the service role; defaultDeps.authorize
// enforces that. Orchestration lives in handler.ts.
import { handleAnalyze } from "./handler.ts";

Deno.serve((req) => handleAnalyze(req));

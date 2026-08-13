// Edge Function entry for field-mission analysis. verify_jwt=true (config.toml);
// resolveActor re-verifies, requireEnterprise gates, and the package query is
// scoped to the caller's own user_id. Logic in handler.ts.
import { handleAnalyzeMission } from "./handler.ts";

Deno.serve((req) => handleAnalyzeMission(req));

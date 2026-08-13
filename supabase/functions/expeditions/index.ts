// Edge Function entry for the field sync API. verify_jwt=true (config.toml);
// resolveActor re-verifies + requireEnterprise gates (owner beta). Logic in handler.ts.
import { handleExpeditions } from "./handler.ts";

Deno.serve((req) => handleExpeditions(req));

// Edge Function entry for the Sample Submission API. verify_jwt=true (config.toml);
// resolveActor re-verifies + requireEnterprise gates (owner beta). Logic in handler.ts.
import { handleSamples } from "./handler.ts";

Deno.serve((req) => handleSamples(req));

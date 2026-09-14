// Edge Function entry for Team Phase 7 cross-contributor cell synthesis.
// verify_jwt=true (config.toml); resolveActor re-verifies + requireEnterprise
// gates. Logic in handler.ts.
import { handleMissionSynthesis } from "./handler.ts";

Deno.serve((req) => handleMissionSynthesis(req));

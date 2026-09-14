// Edge Function entry for Team Phase 9 follow-up missions. verify_jwt=true
// (config.toml); resolveActor re-verifies + the RPC re-checks authorization.
// Logic in handler.ts.
import { handleCreateFollowupMission } from "./handler.ts";

Deno.serve((req) => handleCreateFollowupMission(req));

// Edge Function entry for object-storage presigning. verify_jwt=true
// (config.toml); resolveActor re-verifies and geo.claim_mission gates ownership.
// Logic in handler.ts.
import { handlePresign } from "./handler.ts";

Deno.serve((req) => handlePresign(req));

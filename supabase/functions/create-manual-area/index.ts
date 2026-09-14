// Edge Function entry for manually creating a mission area (no AI
// recommendation involved). verify_jwt=true (config.toml); resolveActor
// re-verifies + the RPC re-checks authorization. Logic in handler.ts.
import { handleCreateManualArea } from "./handler.ts";

Deno.serve((req) => handleCreateManualArea(req));

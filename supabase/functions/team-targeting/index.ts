// Solo→Team shared-targeting Phase 1. Logic lives in handler.ts (testable
// without a live Supabase project via Deps injection); this file is the Deno
// entrypoint, matching geocontext/index.ts's shape.
import { handleTeamTargeting } from "./handler.ts";

Deno.serve((req) => handleTeamTargeting(req));

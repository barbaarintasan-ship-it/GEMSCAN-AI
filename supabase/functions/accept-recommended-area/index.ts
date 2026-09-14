// Solo→Team shared-targeting Phase 2. Logic lives in handler.ts (testable
// without a live Supabase project via Deps injection); this file is the Deno
// entrypoint, matching generate-mission-cells/index.ts's shape.
import { handleAcceptRecommendedArea } from "./handler.ts";

Deno.serve((req) => handleAcceptRecommendedArea(req));

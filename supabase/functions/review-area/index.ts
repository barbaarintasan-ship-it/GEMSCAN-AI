// Phase 11 — Human Geological Review. Logic lives in handler.ts (testable
// without a live Supabase project via Deps injection); this file is the
// Deno entrypoint, matching accept-recommended-area/index.ts's shape.
import { handleReviewArea } from "./handler.ts";

Deno.serve((req) => handleReviewArea(req));

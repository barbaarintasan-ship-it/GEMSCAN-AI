// Phase 12 — "Why A > B" comparative reasoning. Logic lives in handler.ts
// (testable without a live Supabase project via Deps injection); this file
// is the Deno entrypoint, matching review-area/index.ts's shape.
import { handleCompareAreas } from "./handler.ts";

Deno.serve((req) => handleCompareAreas(req));

// Phase 13 — Geological Analogue Matching. Logic lives in handler.ts
// (testable without a live Supabase project via Deps injection); this file
// is the Deno entrypoint, matching compare-areas/index.ts's shape.
import { handleAreaGeologicalAnalogues } from "./handler.ts";

Deno.serve((req) => handleAreaGeologicalAnalogues(req));

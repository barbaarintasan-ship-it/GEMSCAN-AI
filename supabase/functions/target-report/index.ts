// Phase 14 — Unified Target Report. Logic lives in handler.ts (testable
// without a live Supabase project via Deps injection); this file is the
// Deno entrypoint, matching compare-areas/index.ts's shape.
import { handleTargetReport } from "./handler.ts";

Deno.serve((req) => handleTargetReport(req));

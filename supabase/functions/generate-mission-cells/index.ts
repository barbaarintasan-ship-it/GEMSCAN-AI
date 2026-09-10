// Phase 2B — H3 area enumeration. Logic lives in handler.ts (testable
// without a live Supabase project via Deps injection); this file is the
// Deno entrypoint, matching enterprise-samples/index.ts's shape.
import { handleGenerateMissionCells } from "./handler.ts";

Deno.serve((req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }
  return handleGenerateMissionCells(req);
});

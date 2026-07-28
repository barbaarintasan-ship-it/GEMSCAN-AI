// Edge Function entry for the geologist review endpoint. verify_jwt=true (config.toml);
// resolveActor re-verifies + requireReviewer/requireVerifier gate. Logic in handler.ts.
import { handleReview } from "./handler.ts";

Deno.serve((req) => handleReview(req));

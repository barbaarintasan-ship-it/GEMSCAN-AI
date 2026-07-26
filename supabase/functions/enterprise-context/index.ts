// Edge Function entry point for the enterprise context/status endpoint.
// verify_jwt = true (config.toml) — the platform rejects unauthenticated calls;
// resolveActor re-verifies and resolves identity. All logic lives in handler.ts
// so it can be unit-tested with injected dependencies.
import { handleContext } from "./handler.ts";

Deno.serve((req) => handleContext(req));

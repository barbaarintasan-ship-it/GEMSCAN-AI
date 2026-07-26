// Edge Function entry for the GeoContext runtime endpoint. verify_jwt=true
// (config.toml); resolveActor re-verifies and requireEnterprise gates access.
// All logic lives in handler.ts for unit-testability.
import { handleGeoContext } from "./handler.ts";

Deno.serve((req) => handleGeoContext(req));

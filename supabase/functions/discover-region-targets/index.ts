import { handleDiscoverRegionTargets } from "./handler.ts";
Deno.serve((req) => handleDiscoverRegionTargets(req));

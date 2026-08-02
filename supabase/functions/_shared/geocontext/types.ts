// Moved to the shared geological core (shared/geo-core) so the SAME
// deterministic logic runs on the server and in the mobile app.
// This file is a re-export shim: every existing server import is unchanged.
export * from "../../../../shared/geo-core/types.ts";

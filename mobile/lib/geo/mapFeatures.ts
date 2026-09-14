// Moved to the shared geological core (shared/geo-core) so Team's server-side
// scoring can call the identical structural-evidence functions Solo uses. This
// file is a re-export shim: every existing Solo import is unchanged.
export * from "../../../shared/geo-core/geo/mapFeatures.ts";

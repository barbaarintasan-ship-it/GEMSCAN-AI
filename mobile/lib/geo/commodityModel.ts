// Moved to the shared geological core (shared/geo-core) so the SAME commodity
// conditioning runs server-side (Team) too. This file is a re-export shim:
// every existing Solo import is unchanged.
export * from "../../../shared/geo-core/geo/commodityModel.ts";

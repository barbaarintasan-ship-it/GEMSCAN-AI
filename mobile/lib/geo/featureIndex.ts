// Moved to the shared geological core (shared/geo-core) — pure index math with
// no h3/React Native dependency, now reused by the shared structural-evidence
// module (mapFeatures.ts) that Team scoring calls too. Re-export shim: every
// existing Solo import is unchanged.
export * from "../../../shared/geo-core/geo/featureIndex.ts";

// Moved to the shared geological core (shared/geo-core) so the SAME evidence
// vocabulary is available to server-side (Team) scoring. This file is a
// re-export shim: every existing Solo import is unchanged.
export * from "../../../shared/geo-core/geo/evidenceRoles.ts";

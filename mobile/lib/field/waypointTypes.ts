// Field Exploration Engine — Waypoint domain contracts (Phase 2, Milestone 2.1).
//
// Dependency-free by the same rule as types.ts: no expo, no react, no
// react-native. Everything here is data shape plus pure derivation, so the
// capture policy is testable without a device.
//
// Position and heading are COPIED into a waypoint at capture time, never
// referenced. A waypoint is a record of where the geologist stood when they
// saw something; a later fix must never be able to move it.
import type { FieldFix, FieldHeading } from "./types";

// ── Waypoint type catalogue ─────────────────────────────────────────────────
// Stable ids, ordered as a geologist works outward from the rock: what it is,
// what changed it, what hosts it, then the catch-all. Display copy lives in
// i18n (the app is bilingual) — this module carries no user-facing strings.
export const WAYPOINT_TYPES = [
  "outcrop",
  "float",
  "quartz-vein",
  "vein",
  "sulfides",
  "gossan",
  "alteration",
  "fault",
  "contact",
  "other",
] as const;

export type WaypointType = (typeof WAYPOINT_TYPES)[number];

const WAYPOINT_TYPE_SET: ReadonlySet<string> = new Set(WAYPOINT_TYPES);

export function isWaypointType(v: string): v is WaypointType {
  return WAYPOINT_TYPE_SET.has(v);
}

/** i18n key for a type; the UI owns the copy, the domain owns the id. */
export function waypointTypeLabelKey(type: WaypointType): string {
  return `field.waypointType.${type}`;
}

// ── Captured sensor state ───────────────────────────────────────────────────
export interface WaypointPosition {
  lat: number;
  lng: number;
  accuracyM: number | null;
  altitudeM: number | null;
  fixedAt: number;      // timestamp OF THE FIX, not of the capture
  ageMs: number;        // capturedAt − fixedAt: how stale the fix already was
  provisional: boolean; // Phase 1 flag: a cached last-known position
}

export interface WaypointHeadingSample {
  trueHeading: number;
  magneticHeading: number;
  accuracy: number;
  needsCalibration: boolean;
  sampledAt: number;
}

export interface WaypointPhoto {
  id: string;
  uri: string;               // local file:// copy owned by the app
  capturedAt: number;
  remotePath: string | null; // set by the 2.5 sync layer, null while local-only
}

export type WaypointSyncState = "local" | "queued" | "synced";

export interface Waypoint {
  id: string;
  sessionId: string | null; // field session it was captured in, if any
  trackId: string | null;   // reserved for Milestone 2.2 linkage
  type: WaypointType;
  name: string | null;
  notes: string;
  position: WaypointPosition | null;
  heading: WaypointHeadingSample | null;
  photos: WaypointPhoto[];
  capturedAt: number;
  updatedAt: number;
  syncState: WaypointSyncState;
  deletedAt: number | null; // soft delete, so sync can propagate the removal
}

// ── Position quality ────────────────────────────────────────────────────────
// A waypoint with no usable fix is still worth recording — the observation is
// real even when the sky is not. Quality is DERIVED and shown, so a degraded
// position is labelled rather than silently trusted or silently discarded.
export type PositionQuality = "good" | "degraded" | "stale" | "none";

/** Beyond this the fix describes where the geologist *was*, not where they are. */
export const WAYPOINT_STALE_FIX_MS = 60_000;
/** Accuracy worse than this cannot pin an outcrop; it still locates the area. */
export const WAYPOINT_DEGRADED_ACCURACY_M = 25;

export function positionQuality(p: WaypointPosition | null): PositionQuality {
  if (!p) return "none";
  if (p.ageMs > WAYPOINT_STALE_FIX_MS) return "stale";
  if (p.provisional) return "degraded";
  if (p.accuracyM == null) return "degraded";
  return p.accuracyM <= WAYPOINT_DEGRADED_ACCURACY_M ? "good" : "degraded";
}

// ── Projections from Phase 1 snapshots ──────────────────────────────────────
export function positionFromFix(fix: FieldFix | null, capturedAt: number): WaypointPosition | null {
  if (!fix) return null;
  return {
    lat: fix.lat,
    lng: fix.lng,
    accuracyM: fix.accuracy,
    altitudeM: fix.altitude,
    fixedAt: fix.timestamp,
    ageMs: Math.max(0, capturedAt - fix.timestamp),
    provisional: fix.provisional,
  };
}

export function headingSampleFrom(
  heading: FieldHeading | null,
  sampledAt: number,
): WaypointHeadingSample | null {
  if (!heading) return null;
  return {
    trueHeading: heading.trueHeading,
    magneticHeading: heading.magneticHeading,
    accuracy: heading.accuracy,
    needsCalibration: heading.needsCalibration,
    sampledAt,
  };
}

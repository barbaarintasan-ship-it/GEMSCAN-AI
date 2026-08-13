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
  /**
   * A point recorded BECAUSE a sample was taken there.
   *
   * The only addition to this catalogue. "mineral-occurrence" was considered and
   * rejected: an occurrence is a database concept that reads as a confirmed
   * deposit, and a waypoint is one person's field observation. The existing finer
   * types — quartz-vein, sulfides, gossan — already say what was seen.
   *
   * It carries NO scoring weight: see localEvidence, where TYPE_SIGNAL is partial
   * and absence means "not a signal". Collecting a sample says nothing about what
   * is in it until the assay comes back.
   */
  "sample-location",
  "other",
] as const;

export type WaypointType = (typeof WAYPOINT_TYPES)[number];

// ── Samples ─────────────────────────────────────────────────────────────────
// A sample is OPTIONAL on a waypoint. Most field observations are looked at and
// photographed, not collected — so `sample` is absent on most records, and every
// waypoint written before this existed stays valid without migration.

export const SAMPLE_TYPES = ["rock", "soil", "sediment", "mineral-specimen", "other"] as const;
export type SampleType = (typeof SAMPLE_TYPES)[number];

export const COLLECTION_METHODS = ["surface", "outcrop", "float", "stream-sediment"] as const;
export type CollectionMethod = (typeof COLLECTION_METHODS)[number];

export interface WaypointSample {
  /**
   * The label written on the bag. Auto-generated, then editable — because the
   * geologist may already have a numbering scheme, and a system that overrides what
   * is physically on the sample bag creates a mismatch nobody can resolve later.
   */
  sampleId: string;
  sampleType: SampleType;
  collectionMethod: CollectionMethod;
  /** The geologist's own words: "White quartz vein with iron staining". */
  description: string;
}

/** i18n keys; the domain carries ids, the UI carries copy. */
export const sampleTypeLabelKey = (t: SampleType): string => `field.sampleType.${t}`;
export const collectionMethodLabelKey = (m: CollectionMethod): string =>
  `field.collectionMethod.${m}`;

const SAMPLE_TYPE_SET: ReadonlySet<string> = new Set(SAMPLE_TYPES);
const METHOD_SET: ReadonlySet<string> = new Set(COLLECTION_METHODS);
export const isSampleType = (v: string): v is SampleType => SAMPLE_TYPE_SET.has(v);
export const isCollectionMethod = (v: string): v is CollectionMethod => METHOD_SET.has(v);

/** Prefix on every generated sample id. Luul Scan. */
export const SAMPLE_ID_PREFIX = "LW";

/**
 * The next sample id for a day, e.g. `LW-20260810-001`.
 *
 * Derived from the samples that ALREADY EXIST rather than from a stored counter: a
 * counter and a record set can disagree after a restore or a partial sync, and the
 * id printed on a bag has to be unique in the record that actually exists.
 * Sequence is per calendar day, so a day's samples read in order.
 */
export function nextSampleId(
  existing: ReadonlyArray<{ sample?: WaypointSample | null }>,
  at: number,
): string {
  const d = new Date(at);
  const day = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}` +
    `${String(d.getUTCDate()).padStart(2, "0")}`;
  const prefix = `${SAMPLE_ID_PREFIX}-${day}-`;
  let highest = 0;
  for (const w of existing) {
    const id = w.sample?.sampleId;
    if (!id || !id.startsWith(prefix)) continue;
    const n = Number.parseInt(id.slice(prefix.length), 10);
    if (Number.isFinite(n) && n > highest) highest = n;
  }
  return `${prefix}${String(highest + 1).padStart(3, "0")}`;
}

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

/**
 * Whether the geologist saw this, or was told about it.
 *
 * `observed` is everything the app recorded before this existed, and everything
 * captured while standing on the ground: the position comes from the receiver and
 * the photographs from the camera in the same hand.
 *
 * `reported` is somebody else's. A colleague in Borama sends a coordinate, three
 * photographs of a quartz vein and a paragraph of notes; the geologist enters them
 * from four hundred kilometres away. Every part of that is real evidence and worth
 * assessing — and none of it is a thing this phone witnessed.
 *
 * IT IS RECORDED BECAUSE THE REPORT MUST NOT LIE. The whole package is written in
 * the voice of someone who was there — the form says so: "a position entered by
 * hand is one nobody can check". An assessment that treats a forwarded photograph
 * as first-hand observation is a claim no one can stand behind, and the geologist
 * reading it months later has no way to tell. One field, carried all the way to
 * the model, keeps that honest.
 */
export type EvidenceOrigin = "observed" | "reported";

/**
 * A position somebody else supplied, rather than one this device measured.
 *
 * `accuracyM` is null and stays null: a coordinate read off a message has no
 * measured accuracy, and inventing one would be worse than admitting none. That
 * makes `positionQuality` call it `degraded`, which is exactly right — it is a
 * usable position of unknown precision, not a bad one.
 */
export function positionReported(lat: number, lng: number, at: number): WaypointPosition {
  return {
    lat, lng,
    accuracyM: null,
    altitudeM: null,
    // Not stale: it was supplied now, and ageMs measures how old a FIX was when it
    // was used. A reported coordinate has no fix to be old.
    fixedAt: at,
    ageMs: 0,
    provisional: false,
  };
}

/** A coordinate a person could plausibly have meant. Rejects the empty box. */
export function isUsableCoordinate(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 &&
    !(lat === 0 && lng === 0);   // null island is a parse failure, not a place
}

export interface WaypointHeadingSample {
  trueHeading: number;
  magneticHeading: number;
  accuracy: number;
  needsCalibration: boolean;
  sampledAt: number;
}

/**
 * What the field camera writes today, and the assumption every older record was
 * saved under.
 *
 * Named rather than repeated as a literal: the same string decides the local
 * filename, the upload header, the object's extension in R2 and the key stored in
 * the database, and those four disagreeing is exactly the failure this constant
 * exists to prevent.
 */
export const DEFAULT_PHOTO_CONTENT_TYPE = "image/jpeg";

export interface WaypointPhoto {
  id: string;
  uri: string;               // local file:// copy owned by the app
  capturedAt: number;
  /**
   * The MIME type of the bytes on disk.
   *
   * Optional because records written before this field existed do not carry it —
   * and those are all JPEG, which is what `DEFAULT_PHOTO_CONTENT_TYPE` resolves
   * them to. It travels to the server because the object's extension is derived
   * from it, and a photograph stored under one extension and looked for under
   * another is a photograph that is never found.
   */
  contentType?: string;
  remotePath: string | null; // set by the 2.5 sync layer, null while local-only
}

export type WaypointSyncState = "local" | "queued" | "synced";

export interface Waypoint {
  id: string;
  sessionId: string | null; // field session it was captured in, if any
  trackId: string | null;   // reserved for Milestone 2.2 linkage
  /**
   * The investigation this observation belongs to.
   *
   * `sessionId` and `trackId` identify a WALK, and a walk can contain several
   * missions — so neither can say which target's evidence this is. Without it a
   * package built for one mission swept in every observation of the whole
   * traverse, and the AI assessed one target against another target's rock.
   *
   * Optional and additive: absent on records written before this existed, and
   * absent on observations captured between missions. Both still work — the
   * package falls back to the session rule for them.
   */
  missionId?: string | null;
  type: WaypointType;
  name: string | null;
  notes: string;
  position: WaypointPosition | null;
  heading: WaypointHeadingSample | null;
  photos: WaypointPhoto[];
  /**
   * The sample taken here, when one was.
   *
   * Optional and additive: absent on every record written before samples existed,
   * and absent on the many observations that are looked at rather than collected.
   * `undefined` and `null` both mean "no sample" — no migration, no backfill.
   */
  sample?: WaypointSample | null;
  /**
   * Seen here, or sent from somewhere else. See `EvidenceOrigin`.
   *
   * Optional and additive: absent on every record written before this existed, and
   * absent means `observed`, which is what all of them were.
   */
  origin?: EvidenceOrigin;
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

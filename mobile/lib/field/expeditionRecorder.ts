// The expedition — the server-side identity of a walk, managed for the user.
//
// ARCHITECTURE V2 §6: *the user never manages an expedition.* They open the map
// and start exploring; the software opens the record, attributes everything
// collected to it, and closes it. The geologist thinks about geology.
//
// The identity already exists. `ExplorationOrchestrator` mints an
// `explorationSessionId` on Start and clears it on Stop, and the track recorder
// is already scoped to it. This module gives that id a life beyond the device:
// it becomes `device_session_id` on the server, which is also what makes the
// upload idempotent — an expedition can be walked on Monday, uploaded on Friday,
// retried twice on the way, and still be one row.
//
// Everything is written to the OUTBOX, never to the network. This module has no
// idea whether there is a signal, and that is the point: it runs identically in
// a wadi and in an office.
//
// Dependency-free of expo and react, like the rest of lib/field, so the whole
// lifecycle is testable without a device.
import type { Outbox } from "../sync/outbox";
import type { TrackStats } from "./trackRecorder";
import type { Waypoint } from "./waypointTypes";

export interface KeyValueAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/** What the device knows about one walk. */
export interface LocalExpedition {
  /** The orchestrator's session id — `device_session_id` on the server. */
  sessionId: string;
  startedAt: number;
  endedAt: number | null;
  status: "active" | "closed";
  /** From the track recorder's own accumulated stats, not recomputed. */
  distanceM: number;
  movingMs: number;
  observationCount: number;
}

interface Envelope {
  version: 1;
  expeditions: LocalExpedition[];
}

export const EXPEDITION_STORAGE_KEY = "field.expeditions.v1";

/** Closed expeditions kept on the device after the server has them. */
const KEEP_CLOSED = 50;

/**
 * How much new ground triggers another track snapshot.
 *
 * The track is uploaded as one record per expedition, re-queued as it grows —
 * the outbox replaces an unsent entry with the same id, so this costs one write,
 * not one per point. 250 m is often enough that a phone dying mid-traverse loses
 * a couple of minutes of line rather than the walk.
 */
export const TRACK_SNAPSHOT_EVERY_M = 250;

/** ...and a time floor, for a geologist working a single outcrop for an hour. */
export const TRACK_SNAPSHOT_EVERY_MS = 300_000;

export type TrackPointWire = [number, number];

export class ExpeditionRecorder {
  private expeditions: LocalExpedition[] = [];
  private storage: KeyValueAdapter;
  private outbox: Outbox;
  private now: () => number;
  private loaded = false;
  /** The single in-flight read, shared by every caller. */
  private loading: Promise<void> | null = null;

  private lastTrackAtM = 0;
  private lastTrackAtMs = 0;

  constructor(deps: { outbox: Outbox; storage: KeyValueAdapter; now?: () => number }) {
    this.outbox = deps.outbox;
    this.storage = deps.storage;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Read storage once, and make every caller wait for the SAME read.
   *
   * THE BUG THIS FIXES, because it cost an expedition. `loaded` was set to true
   * BEFORE the await, so the second caller in a tick saw `true` and returned from
   * a read that had not finished — with the collection still empty. In the app the
   * route's hook always won that race and the exploration provider always lost, so
   * the stored lease was invisible at startup and a walk interrupted by a process
   * kill could not be resumed: the phone had the lease on disk and reported no
   * expedition. Four launches in a row, reproducible.
   *
   * The same shape was in five stores, and in three of them it is worse than a
   * lost lease: `add()` awaits `load()` and then persists, so a write landing
   * inside that window would have overwritten every unsent record on disk with
   * one entry. That is the byte-loss path the Field Reliability Contract exists to
   * forbid, and it was reachable.
   *
   * `loaded` is now set in a `finally` after the read genuinely completes, and the
   * in-flight promise is shared.
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loading ??= this.readOnce();
    await this.loading;
  }

  private async readOnce(): Promise<void> {
    try {
      const raw = await this.storage.getItem(EXPEDITION_STORAGE_KEY);
      if (!raw) return;
      const env = JSON.parse(raw) as Envelope;
      if (env?.version === 1 && Array.isArray(env.expeditions)) {
        this.expeditions = env.expeditions.filter((e) => typeof e?.sessionId === "string");
      }
    } catch {
      // Unreadable. The walk about to happen matters more than the walk before.
    } finally {
      this.loaded = true;
    }
  }

  current(): LocalExpedition | null {
    return this.expeditions.find((e) => e.status === "active") ?? null;
  }

  all(): readonly LocalExpedition[] {
    return this.expeditions;
  }

  /**
   * Start of a session.
   *
   * Idempotent on the session id: the workspace may re-run this after a
   * remount, and a walk must not become two expeditions because a screen
   * re-rendered.
   *
   * An expedition still marked active for a DIFFERENT session is one the app was
   * killed during. It is closed with what was last known about it rather than
   * abandoned — a crash is not a reason to lose a day's ground.
   */
  async open(sessionId: string, startedAt = this.now()): Promise<LocalExpedition> {
    await this.load();

    const existing = this.expeditions.find((e) => e.sessionId === sessionId);
    if (existing) {
      if (existing.status === "active") return existing;
      // Re-opening a closed session id would rewrite history; treat it as done.
      return existing;
    }

    for (const stale of this.expeditions.filter((e) => e.status === "active")) {
      await this.closeRecord(stale, stale.endedAt ?? startedAt, "recovered");
    }

    const rec: LocalExpedition = {
      sessionId,
      startedAt,
      endedAt: null,
      status: "active",
      distanceM: 0,
      movingMs: 0,
      observationCount: 0,
    };
    this.expeditions.push(rec);
    this.lastTrackAtM = 0;
    this.lastTrackAtMs = startedAt;
    await this.persist();

    await this.outbox.enqueue("expedition.open", sessionId, sessionId, {
      device_session_id: sessionId,
      started_at: new Date(startedAt).toISOString(),
    });
    return rec;
  }

  /** End of a session: the final stats, and the record is complete. */
  async close(sessionId: string, stats?: Pick<TrackStats, "distanceM" | "movingMs">): Promise<void> {
    await this.load();
    const rec = this.expeditions.find((e) => e.sessionId === sessionId);
    if (!rec || rec.status === "closed") return;
    if (stats) {
      rec.distanceM = stats.distanceM;
      rec.movingMs = stats.movingMs;
    }
    await this.closeRecord(rec, this.now(), "ended");
  }

  private async closeRecord(rec: LocalExpedition, endedAt: number, reason: string): Promise<void> {
    rec.status = "closed";
    rec.endedAt = endedAt;
    this.prune();
    await this.persist();
    await this.outbox.enqueue("expedition.close", rec.sessionId, rec.sessionId, {
      device_session_id: rec.sessionId,
      ended_at: new Date(endedAt).toISOString(),
      distance_m: Math.round(rec.distanceM),
      moving_ms: Math.round(rec.movingMs),
      observation_count: rec.observationCount,
      closed_by: reason,
    });
  }

  /**
   * An observation, queued for the server.
   *
   * Keyed on the waypoint's own id, so an edit reaches the server as one row in
   * its final state and a retry after a timeout cannot create a second pin.
   * A soft-deleted waypoint is queued too — a deletion the server never hears
   * about is a pin that comes back.
   */
  async recordObservation(sessionId: string, w: Waypoint): Promise<void> {
    await this.load();
    await this.outbox.enqueue("observation", sessionId, w.id, {
      local_id: w.id,
      device_session_id: sessionId,
      object_type: w.type,
      name: w.name,
      notes: w.notes,
      lat: w.position?.lat ?? null,
      lng: w.position?.lng ?? null,
      // As reported by the receiver, unrounded — a reviewer needs to know
      // whether this pin is worth a metre or fifty.
      gps_accuracy_m: w.position?.accuracyM ?? null,
      altitude_m: w.position?.altitudeM ?? null,
      fix_age_ms: w.position?.ageMs ?? null,
      provisional: w.position?.provisional ?? false,
      heading_deg: w.heading?.trueHeading ?? null,
      photo_count: w.photos.length,
      captured_at: new Date(w.capturedAt).toISOString(),
      updated_at: new Date(w.updatedAt).toISOString(),
      deleted_at: w.deletedAt ? new Date(w.deletedAt).toISOString() : null,
    });

    const rec = this.expeditions.find((e) => e.sessionId === sessionId);
    if (rec && !w.deletedAt) {
      rec.observationCount = Math.max(rec.observationCount, 0) + 1;
      await this.persist();
    }
  }

  /**
   * The traverse so far.
   *
   * One record per expedition, re-queued as it grows: the outbox replaces an
   * unsent entry with the same id, so a long walk costs one queue slot rather
   * than one per point. Gated on distance and time so this is not a write per
   * fix.
   */
  async recordTrack(
    sessionId: string,
    points: readonly TrackPointWire[],
    stats: Pick<TrackStats, "distanceM" | "movingMs">,
    opts: { force?: boolean } = {},
  ): Promise<boolean> {
    await this.load();
    if (points.length < 2) return false;

    const now = this.now();
    const grown = stats.distanceM - this.lastTrackAtM;
    const waited = now - this.lastTrackAtMs;
    if (!opts.force && grown < TRACK_SNAPSHOT_EVERY_M && waited < TRACK_SNAPSHOT_EVERY_MS) {
      return false;
    }
    this.lastTrackAtM = stats.distanceM;
    this.lastTrackAtMs = now;

    const rec = this.expeditions.find((e) => e.sessionId === sessionId);
    if (rec) {
      rec.distanceM = stats.distanceM;
      rec.movingMs = stats.movingMs;
      await this.persist();
    }

    await this.outbox.enqueue("track", sessionId, sessionId + ":track", {
      device_session_id: sessionId,
      // [lng, lat] pairs — GeoJSON axis order, so the server can build a
      // LineString without flipping anything.
      points,
      distance_m: Math.round(stats.distanceM),
      moving_ms: Math.round(stats.movingMs),
      point_count: points.length,
    });
    return true;
  }

  private prune(): void {
    const closed = this.expeditions.filter((e) => e.status === "closed");
    if (closed.length <= KEEP_CLOSED) return;
    const drop = new Set(
      closed.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0)).slice(0, closed.length - KEEP_CLOSED),
    );
    this.expeditions = this.expeditions.filter((e) => !drop.has(e));
  }

  private async persist(): Promise<void> {
    const env: Envelope = { version: 1, expeditions: this.expeditions };
    try {
      await this.storage.setItem(EXPEDITION_STORAGE_KEY, JSON.stringify(env));
    } catch {
      // The outbox already holds what matters; this is the local mirror.
    }
  }
}

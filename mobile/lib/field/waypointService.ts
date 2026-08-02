// Field Exploration Engine — WaypointService (Phase 2, Milestone 2.1).
//
// The Field Services layer: UI → WaypointService → FieldSessionController.
// It reads position and heading ONLY from the controller's snapshot. It never
// touches LocationService, HeadingService or expo-location — Phase 1 owns the
// sensors, and there is exactly one of each in the app.
import type { SessionSnapshot } from "./types";
import { WaypointStore } from "./waypointStore";
import {
  headingSampleFrom,
  positionFromFix,
  positionQuality,
  type PositionQuality,
  type Waypoint,
  type WaypointPhoto,
  type WaypointType,
} from "./waypointTypes";

/**
 * The only thing this service needs from Phase 1. `FieldSessionController`
 * satisfies it structurally, so the dependency is real but the tests stay
 * free of native modules.
 */
export interface FieldSessionSource {
  getSnapshot(): SessionSnapshot;
}

export interface CaptureWaypointInput {
  type: WaypointType;
  name?: string | null;
  notes?: string;
  /** Camera/library uris; copied into app-owned storage before the save. */
  photoUris?: string[];
  /** Track linkage, supplied by Milestone 2.2 once tracks exist. */
  trackId?: string | null;
}

export interface WaypointMutationResult {
  waypoint: Waypoint;
  quality: PositionQuality;
  /** Source uris that could not be copied. The waypoint is saved regardless. */
  photoFailures: string[];
}

export type WaypointPatch = Partial<Pick<Waypoint, "type" | "name" | "notes" | "trackId">>;

export class WaypointService {
  private seq = 0; // instance-scoped: no module-level mutable state

  constructor(
    private readonly session: FieldSessionSource,
    private readonly store: WaypointStore,
    private readonly now: () => number = Date.now,
  ) {}

  // ── Capture ───────────────────────────────────────────────────────────────
  /**
   * Record what the geologist is looking at, with whatever the engine knows
   * right now. A missing or stale fix does NOT block the capture — the
   * observation is real even when the sky is not — it is recorded as such and
   * surfaced through `quality`.
   */
  async capture(input: CaptureWaypointInput): Promise<WaypointMutationResult> {
    await this.store.load();
    const capturedAt = this.now();
    const snap = this.session.getSnapshot();

    const { photos, failures } = await this.persistPhotos(input.photoUris ?? [], capturedAt);

    const waypoint: Waypoint = {
      id: this.nextId(capturedAt),
      sessionId: snap.sessionId,
      trackId: input.trackId ?? null,
      type: input.type,
      name: input.name?.trim() ? input.name.trim() : null,
      notes: input.notes?.trim() ?? "",
      position: positionFromFix(snap.lastFix, capturedAt),
      heading: headingSampleFrom(snap.lastHeading, capturedAt),
      photos,
      capturedAt,
      updatedAt: capturedAt,
      syncState: "local",
      deletedAt: null,
    };

    await this.store.put(waypoint);
    return { waypoint, quality: positionQuality(waypoint.position), photoFailures: failures };
  }

  // ── Edits ─────────────────────────────────────────────────────────────────
  /** Notes and classification change; the recorded position never does. */
  async update(id: string, patch: WaypointPatch): Promise<WaypointMutationResult | null> {
    await this.store.load();
    const existing = this.store.get(id);
    if (!existing || existing.deletedAt != null) return null;

    const next: Waypoint = {
      ...existing,
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      ...(patch.trackId !== undefined ? { trackId: patch.trackId } : {}),
      ...(patch.name !== undefined ? { name: patch.name?.trim() ? patch.name.trim() : null } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes.trim() } : {}),
      updatedAt: this.now(),
      syncState: "local", // content changed ⇒ it owes the server another push
    };
    await this.store.put(next);
    return { waypoint: next, quality: positionQuality(next.position), photoFailures: [] };
  }

  async addPhotos(id: string, sourceUris: string[]): Promise<WaypointMutationResult | null> {
    await this.store.load();
    const existing = this.store.get(id);
    if (!existing || existing.deletedAt != null) return null;

    const t = this.now();
    const { photos, failures } = await this.persistPhotos(sourceUris, t);
    if (photos.length === 0) {
      return { waypoint: existing, quality: positionQuality(existing.position), photoFailures: failures };
    }
    const next: Waypoint = {
      ...existing,
      photos: [...existing.photos, ...photos],
      updatedAt: t,
      syncState: "local",
    };
    await this.store.put(next);
    return { waypoint: next, quality: positionQuality(next.position), photoFailures: failures };
  }

  async removePhoto(id: string, photoId: string): Promise<WaypointMutationResult | null> {
    await this.store.load();
    const existing = this.store.get(id);
    if (!existing || existing.deletedAt != null) return null;
    const photo = existing.photos.find((p) => p.id === photoId);
    if (!photo) return null;

    const next: Waypoint = {
      ...existing,
      photos: existing.photos.filter((p) => p.id !== photoId),
      updatedAt: this.now(),
      syncState: "local",
    };
    await this.store.put(next);
    // The record is already saved without it; a failed unlink only leaks a file.
    await this.store.removePhotoFile(photo.uri).catch(() => {});
    return { waypoint: next, quality: positionQuality(next.position), photoFailures: [] };
  }

  /** Soft delete — the tombstone is what tells the server to remove it too. */
  async remove(id: string): Promise<boolean> {
    await this.store.load();
    return (await this.store.softDelete(id, this.now())) != null;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────
  list(sessionId?: string): readonly Waypoint[] { return this.store.visible(sessionId); }
  get(id: string): Waypoint | null { return this.store.get(id); }
  /** Waypoints for the session that is running right now. */
  listCurrentSession(): readonly Waypoint[] {
    const id = this.session.getSnapshot().sessionId;
    return id == null ? [] : this.store.visible(id);
  }
  subscribe(l: () => void): () => void { return this.store.subscribe(l); }

  // ── Internals ─────────────────────────────────────────────────────────────
  private async persistPhotos(
    sourceUris: string[],
    t: number,
  ): Promise<{ photos: WaypointPhoto[]; failures: string[] }> {
    const photos: WaypointPhoto[] = [];
    const failures: string[] = [];
    for (const uri of sourceUris) {
      const photoId = this.nextId(t, "wpp");
      try {
        const local = await this.store.persistPhotoFile(uri, `${photoId}.jpg`);
        photos.push({ id: photoId, uri: local, capturedAt: t, remotePath: null });
      } catch {
        // One unreadable photo must not cost the whole observation.
        failures.push(uri);
      }
    }
    return { photos, failures };
  }

  private nextId(t: number, prefix = "wp"): string {
    return `${prefix}-${t.toString(36)}-${++this.seq}`;
  }
}

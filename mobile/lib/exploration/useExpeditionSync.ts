// The expedition, managed for the geologist.
//
// ARCHITECTURE V2 §6: the user never manages an expedition. They open the map and
// start exploring. This hook is the whole of that promise on the client:
//
//   session starts  → an expedition opens and is queued
//   a waypoint      → queued as an observation
//   the walk grows  → the traverse is queued, periodically
//   session ends    → the expedition closes with its final stats
//   a signal        → the queue drains
//
// It is deliberately a WATCHER, not a participant. It never tells the
// orchestrator anything, never touches the engines, and holds no geological
// state — it observes the session that already exists and files what it sees.
// That is why Slice 2 needed no change to the exploration engine at all.
//
// Everything is durable before any of it is uploaded, so this works identically
// with no signal for a week.
import { useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { Outbox, type OutboxStats } from "../sync/outbox";
import { pushOutbox } from "../sync/pushOutbox";
import { pushPhotos } from "../sync/pushPhotos";
import { pullAnalysis } from "../sync/pullAnalysis";
import type { PackageStore } from "./packageStore";
import type { PhotoUploadQueue } from "../sync/photoUploadQueue";
import { ExpeditionRecorder } from "../field/expeditionRecorder";
import { setCurrentExpedition } from "./currentExpedition";
import { expeditionLease } from "./expeditionLease";
import { measureFrom, roadFactor } from "../geo/roadFactor";
import { haversineM } from "../../../shared/geo-core/geo/spatial.ts";
import { currentIdentity } from "../currentIdentity";
import type { Waypoint } from "../field/waypointTypes";
import type { TrackStats } from "../field/trackRecorder";
import { markPhase } from "../diagnostics/jsStall";

/** How often a running session tries to drain, when there is a connection. */
const DRAIN_INTERVAL_MS = 60_000;

function storageAdapter() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const AsyncStorage = require("@react-native-async-storage/async-storage").default;
  return {
    getItem: (k: string) => AsyncStorage.getItem(k) as Promise<string | null>,
    setItem: (k: string, v: string) => AsyncStorage.setItem(k, v) as Promise<void>,
  };
}

export interface ExpeditionSyncState {
  /** Records collected and not yet filed with the server. */
  pending: number;
  /** ...of which this many have failed repeatedly and want looking at. */
  failing: number;
  /** True while a drain is in flight. */
  syncing: boolean;

  // ── The queue, observable ────────────────────────────────────────────────
  // Everything below is here because "8 held · 4 failing" was the whole of what
  // the field could see. The device knew why each of those four had failed, had
  // known for hours, and had nowhere to say it.
  /** Held on this device, in any state. Nothing is ever dropped unsent. */
  stored: number;
  queued: number;
  retrying: number;
  rejected: number;
  synced: number;
  /** When the earliest backoff expires. */
  nextRetryAt: number | null;
  /** Distinct failure reasons, commonest first. */
  reasons: Array<{ reason: string; count: number; permanent: boolean }>;
  /** Why the last drain could not complete, if it could not. */
  blocked: "offline" | "unauthenticated" | "forbidden" | "transport" | null;
  blockedReason: string | null;
  lastDrainAt: number | null;
}

const EMPTY_SYNC: ExpeditionSyncState = {
  pending: 0, failing: 0, syncing: false,
  stored: 0, queued: 0, retrying: 0, rejected: 0, synced: 0,
  nextRetryAt: null, reasons: [],
  blocked: null, blockedReason: null, lastDrainAt: null,
};

export function useExpeditionSync(input: {
  sessionId: string | null;
  waypoints: readonly Waypoint[];
  trackPoints: Array<[number, number]>;
  trackStats: Pick<TrackStats, "distanceM" | "movingMs">;
  isOnline: boolean;
  /**
   * The photograph queue, when the caller has one.
   *
   * Passed in rather than created here: it belongs to the exploration provider,
   * which is where a finished section fills it, and a second instance over the
   * same storage key would be two state machines fighting over one file.
   */
  photoQueue?: PhotoUploadQueue | null;
  /**
   * The finished sections, so their assessments can be collected.
   *
   * The last leg of the round trip: the outbox sends the package, the photo queue
   * sends the bytes, and this brings the AI geologist's reading back. Without it
   * the workflow has a terminal state nobody can reach — a geologist watching
   * "waiting for analysis" for ever while the report sits finished on the server.
   */
  packages?: PackageStore | null;
  /** Records where a photograph landed, once R2 has confirmed it. */
  onPhotoUploaded?: (photoId: string, r2Key: string) => void | Promise<void>;
}): ExpeditionSyncState {
  const { sessionId, waypoints, trackPoints, trackStats, isOnline } = input;
  const photoQueue = input.photoQueue ?? null;
  const packages = input.packages ?? null;
  // Held in a ref so a new closure identity does not restart the drain timer on
  // every render of a screen that re-renders on every GPS fix.
  const onPhotoUploaded = useRef(input.onPhotoUploaded);
  onPhotoUploaded.current = input.onPhotoUploaded;

  // One graph per mount, exactly like the exploration provider's engines.
  const outbox = useMemo(() => new Outbox(), []);
  const recorder = useMemo(
    () => new ExpeditionRecorder({ outbox, storage: storageAdapter() }),
    [outbox],
  );

  const [state, setState] = useState<ExpeditionSyncState>(EMPTY_SYNC);
  const syncing = useRef(false);

  // The queue's own counts drive the status line. Compared on a signature rather
  // than field by field: `reasons` is a fresh array every read, so an identity
  // check would re-render on every queue event forever.
  useEffect(() => {
    const read = () => {
      const s = outbox.stats();
      setState((prev) => (sig(prev) === statsSig(s) ? prev : { ...prev, ...s }));
    };
    const off = outbox.subscribe(read);
    void outbox.load().then(read);
    return off;
  }, [outbox]);

  // ── The expedition follows the session ───────────────────────────────────
  // Opening is idempotent on the session id, so a remount cannot fork the walk.
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    // Published for screens outside the workspace — the capture screen attributes
    // its sample to whatever walk is running (lib/exploration/currentExpedition).
    setCurrentExpedition(sessionId);
    if (!sessionId || openedFor.current === sessionId) return;
    openedFor.current = sessionId;
    void recorder.open(sessionId);
    // THE LEASE. Written to storage, so an expired token cannot eject this
    // expedition and neither can an Android process kill — the two failures that
    // ended the Karkaar traverse. Attribution is sealed here, at open, from
    // whatever identity is known: it is the record of who collected these
    // observations and no later account action may rewrite it.
    void expeditionLease().open(
      sessionId,
      // ATTRIBUTION only, read from a module slot rather than the auth context:
      // the field pipeline must not require an AuthProvider to be mounted.
      currentIdentity(),
    );
  }, [sessionId, recorder]);

  // ── Re-attaching ─────────────────────────────────────────────────────────
  // Signing back in as the SAME collector re-attaches the open lease, so the
  // detached banner clears and uploading resumes. A DIFFERENT account does not:
  // the held records belong to whoever collected them, and the server must
  // refuse them rather than reattribute (that check is M4 — until then the
  // lease simply stays detached, which is the safe direction to fail).
  useEffect(() => {
    const held = expeditionLease().get();
    const who = currentIdentity();
    if (!held || held.state !== "detached" || !who) return;
    if (held.collectedBy && held.collectedBy.userId !== who.userId) return;
    void expeditionLease().reattach();
  }, [isOnline]);

  // Closing needs the id AFTER the orchestrator has cleared it, and the final
  // stats, which are only complete at that moment — so both are held in refs
  // rather than read from a snapshot that has already moved on.
  const lastSession = useRef<string | null>(null);
  const lastStats = useRef(trackStats);
  const lastPoints = useRef(trackPoints);
  lastStats.current = trackStats;
  lastPoints.current = trackPoints;

  useEffect(() => {
    const previous = lastSession.current;
    lastSession.current = sessionId;
    if (previous && !sessionId) {
      // The walk ended. File the traverse as it finally stood, then close.
      void (async () => {
        await recorder.recordTrack(previous, lastPoints.current, lastStats.current, { force: true });
        await recorder.close(previous, lastStats.current);
        // The lease closes with the walk, and only with the walk. This is the
        // ONLY ordinary path that releases it — Field Reliability Contract,
        // clause 2: the expedition ends when the geologist ends it.
        await expeditionLease().close();
        // MEASURE THE GROUND, at the one moment the whole traverse is known.
        //
        // The travel estimate was computed from a straight line and presented as
        // a drive: a target 94.4 km away read "2 h 42" when the road to it is
        // about 190 km and nearly five hours. The fix is a multiplier, and a
        // multiplier is only honest if it was measured on the ground it is
        // applied to — so every finished walk long enough to teach something
        // contributes one measurement. measureFrom() refuses the ambiguous ones.
        try {
          const pts = lastPoints.current;
          if (pts.length >= 2) {
            const start = { lng: pts[0][0], lat: pts[0][1] };
            let maxDisplacementM = 0;
            for (const [lng, lat] of pts) {
              const d = haversineM(start, { lat, lng });
              if (d > maxDisplacementM) maxDisplacementM = d;
            }
            const last = pts[pts.length - 1];
            const m = measureFrom({
              trackDistanceM: lastStats.current.distanceM,
              maxDisplacementM,
              endDisplacementM: haversineM(start, { lat: last[1], lng: last[0] }),
              at: Date.now(),
            });
            if (m) await roadFactor().record(m);
          }
        } catch {
          // A measurement is an optimisation, never a reason to fail a close.
        }
      })();
    }
  }, [sessionId, recorder]);

  // ── Observations ─────────────────────────────────────────────────────────
  // Queued when a waypoint appears or changes. `updatedAt` is the trigger, so an
  // edited note or a soft delete is filed as well as a new pin.
  const seen = useRef(new Map<string, number>());
  useEffect(() => {
    if (!sessionId) return;
    for (const w of waypoints) {
      if (seen.current.get(w.id) === w.updatedAt) continue;
      seen.current.set(w.id, w.updatedAt);
      void recorder.recordObservation(sessionId, w);
    }
  }, [waypoints, sessionId, recorder]);

  // ── The traverse ─────────────────────────────────────────────────────────
  // The recorder decides whether this is worth a write (distance and time
  // gated), so calling it on every track change costs almost nothing.
  useEffect(() => {
    if (!sessionId) return;
    void recorder.recordTrack(sessionId, trackPoints, trackStats);
  }, [trackPoints, sessionId, recorder]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Draining ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;

    const drain = async () => {
      if (!alive || syncing.current || !isOnline) return;
      // INVESTIGATION: two ~52s unattributed JS-thread freezes recur roughly
      // every 60s once TargetingEngine.rank() was ruled out (it now runs once,
      // ~2.4s). This fires on the same DRAIN_INTERVAL_MS=60_000 timer, so it is
      // the next suspect. Instrumented end to end, including the synchronous
      // .due()/.stats()/.awaitingAnalysis() reads, to find which part is slow
      // rather than guess.
      const doneDrain = markPhase("expeditionSync.drain");
      try {
      const doneDue = markPhase("expeditionSync.drain.due");
      // Photographs are checked alongside the metadata queue: a finished section
      // is not delivered until both have gone, and a drain that only looked at the
      // outbox would leave the evidence itself sitting on the phone for ever.
      const photosDue = photoQueue?.due().length ?? 0;
      // A package whose evidence is all delivered still has an assessment to
      // collect, and nothing else in this condition would ever wake for it.
      const analysesDue = packages?.awaitingAnalysis().length ?? 0;
      const outboxDue = outbox.due().length;
      doneDue();
      if (outboxDue === 0 && photosDue === 0 && analysesDue === 0) return;
      syncing.current = true;
      setState((s) => ({ ...s, syncing: true }));
      // pushOutbox is documented never to throw, and is now written so that it
      // cannot. Caught anyway: a drain that fails in an unforeseen way must not
      // leave `syncing` stuck true, which would stop every later drain.
      let blocked: ExpeditionSyncState["blocked"] = null;
      let blockedReason: string | null = null;
      try {
        const doneOutbox = markPhase(`expeditionSync.drain.pushOutbox[${outboxDue}]`);
        const r = await pushOutbox(outbox, isOnline);
        doneOutbox();
        blocked = r.blocked;
        blockedReason = r.reason;

        // Then the photographs. Independent of the metadata: a package whose rows
        // filed successfully still has nothing to analyse until its images are in
        // R2, and a photo upload failing must not undo the rows that did land.
        if (photoQueue) {
          const donePhotos = markPhase(`expeditionSync.drain.pushPhotos[${photosDue}]`);
          const p = await pushPhotos(photoQueue, isOnline, {
            onUploaded: (id, key) => onPhotoUploaded.current?.(id, key),
          });
          donePhotos();
          if (p.blocked && !blocked) {
            blocked = p.blocked === "unconfigured" ? "transport" : p.blocked;
            blockedReason = p.reason;
          }
        }

        // Last: collect any assessment that is ready. Deliberately after both
        // sends — an analysis cannot exist until its evidence has arrived, so
        // asking first would just be a wasted request every pass.
        if (packages) {
          const doneAnalysis = markPhase(`expeditionSync.drain.pullAnalysis[${analysesDue}]`);
          const a = await pullAnalysis(packages, isOnline);
          doneAnalysis();
          if (a.blocked && !blocked) {
            blocked = a.blocked === "unconfigured" ? "transport" : a.blocked;
            blockedReason = a.reason;
          }
        }
      } catch (err) {
        blocked = "transport";
        blockedReason = err instanceof Error ? err.message : "drain failed";
      } finally {
        syncing.current = false;
        if (alive) {
          const doneStats = markPhase("expeditionSync.drain.finalStats");
          const stats = outbox.stats();
          doneStats();
          setState((s) => ({
            ...s, ...stats, syncing: false,
            blocked, blockedReason, lastDrainAt: Date.now(),
          }));
        }
      }
      } finally {
        doneDrain();
      }
    };

    // Now (the connection may have just returned), on a slow timer while
    // walking, and when the app comes back to the foreground — the three moments
    // a phone in a pocket is most likely to have found a signal.
    void drain();
    const timer = setInterval(() => void drain(), DRAIN_INTERVAL_MS);
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") void drain(); });

    return () => { alive = false; clearInterval(timer); sub.remove(); };
  }, [isOnline, outbox, photoQueue, packages]);

  return state;
}

/** Value signature of the queue counts, so equal counts do not re-render. */
function statsSig(s: OutboxStats): string {
  return [
    s.pending, s.failing, s.stored, s.queued, s.retrying, s.rejected, s.synced,
    s.nextRetryAt ?? "",
    s.reasons.map((r) => r.count + (r.permanent ? "!" : "") + r.reason).join("|"),
  ].join("/");
}

function sig(s: ExpeditionSyncState): string {
  return statsSig(s as unknown as OutboxStats);
}

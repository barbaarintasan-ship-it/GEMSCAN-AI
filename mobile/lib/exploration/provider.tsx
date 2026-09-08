// Exploration Mode — React binding (Stage E4).
//
// Mirrors the Phase 1 FieldSessionProvider pattern: mounted LOCALLY by the
// screen that needs it, never in the root layout, so the engine exists only
// while its screen does and unmount runs a full teardown.
//
// The orchestrator throttles itself (re-targeting is event-driven, not per-fix),
// so this layer re-renders at the rate the sensors already gate.
import React, { createContext, useContext, useEffect, useRef, useSyncExternalStore } from "react";
import { InteractionManager } from "react-native";
import { FieldSessionController } from "../field/sessionController";
import { PackStore, createBundledPackSource } from "../geo/packStore.ts";
import { OfflineGeoContextService } from "../geo/offlineGeoContext.ts";
import { TargetingEngine } from "../geo/targeting.ts";
import {
  ExplorationOrchestrator,
  type CaptureObservationInput, type ExplorationSnapshot, type ResumeExpedition,
} from "./orchestrator.ts";
import { expeditionLease } from "./expeditionLease";
import type { Waypoint, WaypointType } from "../field/waypointTypes";
import type { RegionalTarget } from "../geo/expedition.ts";
import { loadBundledPackFiles } from "../geo/bundledPack.ts";
import { markPhase } from "../diagnostics/jsStall";
import { WaypointStore } from "../field/waypointStore";
import { WaypointService } from "../field/waypointService";
import { makeLocalEvidenceProvider, makeWaypointEvidenceSource } from "./localEvidence.ts";
import { PackageStore } from "./packageStore";
import { PhotoUploadQueue } from "../sync/photoUploadQueue";
import { Outbox } from "../sync/outbox";
import { hotspotIn } from "../geo/hotspot";
import { StructuredEvidenceStore } from "./structuredEvidenceStore";
import type {
  StructuredEvidenceResult, StructuredGeologicalEvidence,
} from "../field/structuredEvidenceTypes";

export interface ExplorationApi {
  snapshot: ExplorationSnapshot;
  orchestrator: ExplorationOrchestrator;
  /** The installed pack, for the offline map and the evidence readout. */
  packs: PackStore;
  /** Finished sections held on the device, with their assessments when they return. */
  packages: PackageStore | null;
  /** Photographs waiting to reach object storage. Never empties by losing one. */
  photoUploads: PhotoUploadQueue | null;
  /**
   * Recorded observations, for the map's waypoint layer.
   *
   * Read straight from the SAME WaypointStore the capture writes to, rather
   * than through the exploration engine. Drawing a pin is a display concern;
   * routing it through the engine would mean changing a working part of the
   * system to move data it does not need.
   */
  waypoints: Array<{ lng: number; lat: number; type: string }>;
  /**
   * The full waypoint records, for export.
   *
   * The map needs three fields per pin; a GPX file needs every one of them —
   * time, notes, altitude, photo count. Exporting from the trimmed pin list
   * would silently drop the parts of a field record that make it a record.
   */
  waypointRecords: readonly Waypoint[];
  /**
   * The User Geological Evidence record for the OPEN mission, or null when
   * nothing has been entered yet — read straight from the same
   * StructuredEvidenceStore the form writes to, for the same reason
   * `waypointRecords` reads straight from the waypoint store.
   */
  structuredEvidence: StructuredGeologicalEvidence | null;
  actions: {
    start: (resume?: ResumeExpedition) => void;
    stop: () => void;
    refresh: () => void;
    selectTarget: (cell: string) => void;
    recordEvidence: () => Promise<void>;
    captureObservation: (input: CaptureObservationInput) => Promise<Waypoint | null>;
    inspectAt: (lat: number, lng: number) => void;
    clearInspect: () => void;
    navigateTo: (lat: number, lng: number) => void;
    /** Navigate to a mapped pack feature at any distance — see orchestrator. */
    navigateToRegional: (target: RegionalTarget) => void;
    /**
     * Take a target the user named, at ANY distance.
     *
     * Distinct from `navigateTo`, which is plain navigation to a coordinate and
     * carries no assessment. This makes the place a real, committed TARGET with the
     * engine's reading attached. Resolves false when the ground has nothing to say.
     */
    selectTargetAt: (lat: number, lng: number) => Promise<boolean>;
    clearDestination: () => void;
    /** Assess for one commodity profile, or null for the universal engine. */
    setCommodity: (code: string | null) => void;
    /** The geologist has started working the ground they arrived on. */
    beginInvestigation: () => void;
    /** FINISH SECTION — assemble the package, write it, queue it. Sends nothing. */
    finishSection: () => Promise<void>;
    /**
     * Append one User Geological Evidence form save to the open mission's
     * record. A mission with no open record yet gets one created on first
     * call — see StructuredEvidenceStore.merge().
     */
    addStructuredEvidence: (result: StructuredEvidenceResult) => Promise<void>;
    /** Close the mission. Only then may the engine recommend somewhere else. */
    closeMission: () => void;
    /** Abandon a hand-picked target and return to the nearest suggestion. */
    cancelChosenTarget: () => void;
    /**
     * Record where a photograph landed in object storage.
     *
     * Called by the sync loop once R2 has confirmed the bytes. `remotePath` was
     * declared on the waypoint record and never written by anything, so a
     * geologist reopening an observation could not tell whether its photographs
     * had left the phone — and neither could a support conversation about it.
     */
    notePhotoUploaded: (photoId: string, r2Key: string) => Promise<void>;
  };
}

const Ctx = createContext<ExplorationApi | null>(null);

/** Stable empty array: a fresh [] on each read would loop useSyncExternalStore. */
const EMPTY_WAYPOINTS: readonly Waypoint[] = [];

export function ExplorationProvider({ children }: { children: React.ReactNode }) {
  const waypointStoreRef = useRef<WaypointStore | null>(null);
  const ref = useRef<ExplorationOrchestrator | null>(null);
  const packsRef = useRef<PackStore | null>(null);
  const packageStoreRef = useRef<PackageStore | null>(null);
  const photoQueueRef = useRef<PhotoUploadQueue | null>(null);
  const structuredEvidenceStoreRef = useRef<StructuredEvidenceStore | null>(null);
  if (ref.current == null) {
    /**
     * MEASURED, because it runs in a render body on the startup path.
     *
     * Everything below is synchronous and happens during the FIRST render of a
     * provider that sits above the router — so it is on the critical path of
     * every cold start, and a Pressable cannot fire until it finishes. The four
     * `void …load()` calls are not: they return immediately and settle later.
     *
     * Naming it means a stall that lands here arrives already attributed instead
     * of as an unexplained four seconds. See lib/diagnostics/jsStall.
     */
    const built = markPhase("app.providers.graph");
    // One graph per mounted provider; never rebuilt across re-renders.
    const packs = new PackStore(createBundledPackSource(loadBundledPackFiles));
    packsRef.current = packs;
    const field = new FieldSessionController();

    // The evidence overlay reads the SAME waypoint store the capture writes to,
    // so what the geologist just recorded is immediately part of the model
    // (Architecture §9) — there is no second copy of the observations.
    const waypointStore = new WaypointStore();
    waypointStoreRef.current = waypointStore;
    void waypointStore.load();
    const waypoints = new WaypointService(field, waypointStore);
    const localEvidence = makeWaypointEvidenceSource(waypointStore);

    const geo = new OfflineGeoContextService(packs, "1.0.0", [
      makeLocalEvidenceProvider(localEvidence),
    ]);
    // Finished sections are written HERE, on the device, before anything is
    // queued. The field has no network and that is the normal case.
    const packages = new PackageStore();
    void packages.load();
    packageStoreRef.current = packages;
    const outbox = new Outbox();
    void outbox.load();
    const structuredEvidenceStore = new StructuredEvidenceStore();
    void structuredEvidenceStore.load();
    structuredEvidenceStoreRef.current = structuredEvidenceStore;
    // Photographs travel separately from the package: the bytes go straight to R2
    // on a presigned URL and only the key reaches Postgres. Queued so a finished
    // section survives no signal, a killed process and an expired URL.
    const photoUploads = new PhotoUploadQueue();
    void photoUploads.load();
    photoQueueRef.current = photoUploads;

    ref.current = new ExplorationOrchestrator({
      field,
      targeting: new TargetingEngine(geo, localEvidence, () => packs.getData()),
      packs,
      waypoints,
      packages,
      outbox,
      // The SAME queue Finish Section uses. A capture hands its photos over
      // immediately; there is no second upload path.
      photoUploads,
      // Injected rather than imported, so the orchestrator keeps no opinion about
      // scoring. Runs once on arrival, over the 49 resolution-9 children of the
      // target cell.
      findHotspot: (cell, commodity) => hotspotIn(geo, packs.getData(), cell, { commodity }),
      // The first scoring pass waits for the app to finish painting. See
      // deferFirstRun — it moves four seconds of cold-start work off the thread
      // that has to answer the geologist's first tap, and changes nothing about
      // what that pass computes.
      //
      // runAfterInteractions ALONE is not enough on a cold boot with a resumed
      // expedition (an open lease from a walk the process died in — see the
      // "RESUME A WALK" effect below): there is no real interaction queue to
      // wait for, so it fires within the same tick as the very first frame.
      // MEASURED on a device with an open lease, from a fully killed cold boot:
      //   [jsStall] UNRESPONSIVE 7763ms IN: subscription.fetch
      //   [jsStall] UNRESPONSIVE 1497ms IN: ... › explore.retarget › targeting.rank[37]
      // targeting.rank (37 cells against the full pack) ran in the SAME window
      // subscription.fetch's response was ready to process and render, and
      // being on one JS thread, one of them had to wait — which is why the
      // header sat on "Sign in" / stale tier for over a minute even though the
      // session and subscription were both already correct. The extra
      // setTimeout gives auth/subscription a full second of the thread to
      // themselves before the CPU-bound ranking pass is even scheduled. It
      // changes nothing about what rank() computes or when a LIVE session's
      // ongoing retargeting runs (deferRank, untouched, below) — only the
      // start-of-session first pass, which is the one with nothing on screen
      // yet to lose by arriving a second later.
      //
      // TRIED, on-device, and reverted: replacing this flat delay with a
      // real "auth actually settled" signal (an event auth.tsx published)
      // instead of a guessed 1000ms. MEASURED across 6 true-cold-boot trials
      // (2 grace settings x 3 trials each): targeting.rank[37] still
      // overlapped subscription.fetch in every trial, with genuine
      // thread-block ("during:" in the jsStall log, not just an open phase)
      // in the same 637-1163ms range as this flat delay produces —
      // statistically indistinguishable, not an improvement. Reverted rather
      // than ship the added complexity (a new module, two more files wired
      // together) for a result the device evidence did not support.
      deferFirstRun: (fn) => { InteractionManager.runAfterInteractions(() => setTimeout(fn, 1000)); },
      // Every ranking run (not just the first) is moved past the current
      // interaction, so tapping Start investigation / Finish section — or crossing
      // a cell — never holds the tap while rank() scores 37 cells. Same result,
      // same InteractionManager pattern as map.buildScene; only the timing moves.
      deferRank: (fn) => { InteractionManager.runAfterInteractions(fn); },
    });
    built();
  }
  const orchestrator = ref.current;

  const waypoints = useSyncExternalStore(
    (cb) => waypointStoreRef.current?.subscribe(cb) ?? (() => {}),
    () => waypointStoreRef.current?.all() ?? EMPTY_WAYPOINTS,
  );

  const snapshot = useSyncExternalStore(
    (cb) => orchestrator.subscribe(cb),
    () => orchestrator.getSnapshot(),
  );

  const missionId = snapshot.mission?.id ?? null;
  const structuredEvidence = useSyncExternalStore(
    (cb) => structuredEvidenceStoreRef.current?.subscribe(cb) ?? (() => {}),
    () => (missionId ? structuredEvidenceStoreRef.current?.get(missionId) ?? null : null),
  );

  useEffect(() => () => orchestrator.destroy(), [orchestrator]);

  /**
   * RESUME A WALK THE PROCESS DIED IN.
   *
   * The lease outlives the process; this object does not. Android reclaims a
   * backgrounded app overnight, and on the next launch the stored lease still
   * says a walk is open while the orchestrator starts at `idle`. That left the
   * two disagreeing in the worst direction: the auth gate held open for an
   * expedition recording nothing, and `stop()` unreachable — so the lease could
   * only be released by its fourteen-day safety net.
   *
   * Resuming is the correct answer rather than closing the lease, because the
   * expedition did not end. The process ended. Field Reliability Contract,
   * clause 2: a walk ends when the geologist ends it.
   *
   * Runs once, and only into `idle` — `start()` itself refuses any other state,
   * so a live session can never be restarted over.
   */
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current) return;
    const store = expeditionLease();
    void store.load().then(() => {
      if (resumed.current) return;
      const lease = store.get();
      if (!lease || !store.isOpen()) return;
      if (orchestrator.getSnapshot().state !== "idle") return;
      resumed.current = true;
      // Same id, same clock: a resumed traverse is the same traverse.
      orchestrator.start({ sessionId: lease.expeditionId, startedAt: lease.openedAt });
    });
  }, [orchestrator]);

  // Only waypoints with a real fix can be drawn; one without a position is a
  // valid observation but has nowhere to go on a map, and putting it at the
  // viewer's own position would invent a location it never had.
  const waypointPins = React.useMemo(
    () =>
      waypoints
        .filter((w) => w.position && !w.deletedAt)
        .map((w) => ({ lng: w.position!.lng, lat: w.position!.lat, type: w.type as string })),
    [waypoints],
  );

  const api: ExplorationApi = {
    snapshot,
    orchestrator,
    packs: packsRef.current!,
    packages: packageStoreRef.current,
    photoUploads: photoQueueRef.current,
    waypoints: waypointPins,
    waypointRecords: waypoints,
    structuredEvidence: structuredEvidence ?? null,
    actions: {
      start: (resume?: ResumeExpedition) => orchestrator.start(resume),
      stop: () => orchestrator.stop(),
      refresh: () => orchestrator.refresh(),
      selectTarget: (cell) => orchestrator.selectTarget(cell),
      recordEvidence: () => orchestrator.recordEvidence(),
      captureObservation: (input) => orchestrator.captureObservation(input),
      inspectAt: (lat, lng) => orchestrator.inspectAt(lat, lng),
      clearInspect: () => orchestrator.clearInspect(),
      navigateTo: (lat, lng) => orchestrator.navigateTo(lat, lng),
      navigateToRegional: (target) => orchestrator.navigateToRegional(target),
      selectTargetAt: (lat, lng) => orchestrator.selectTargetAt(lat, lng),
      clearDestination: () => orchestrator.clearDestination(),
      setCommodity: (code) => orchestrator.setCommodity(code),
      beginInvestigation: () => orchestrator.beginInvestigation(),
      finishSection: async () => {
        // The waypoints live in their own store and the traverse in the recorder;
        // both are handed in rather than reached for, so there is only ever one
        // copy of each in the system. Same rule for the structured evidence form.
        const waypoints = waypointStoreRef.current?.all() ?? [];
        const openMissionId = orchestrator.getSnapshot().mission?.id ?? null;
        const structured = openMissionId
          ? structuredEvidenceStoreRef.current?.get(openMissionId) ?? null
          : null;
        const pkg = await orchestrator.finishSection({
          waypoints, track: [], structuredEvidence: structured,
        });

        // Queue every photograph the package names. Uploading is NOT attempted
        // here: the geologist pressed a button on a mountain and needs an answer
        // now, so this writes to disk and lets the sync layer deliver whenever a
        // network next exists.
        if (pkg) {
          const photos = pkg.observations.flatMap((o) =>
            o.photos.map((ph) => ({ id: ph.id, uri: ph.uri, contentType: ph.contentType })));
          if (photos.length > 0) await photoQueueRef.current?.enqueue(pkg.missionId, photos);
          // Folded into the filed package; a copy living here forever would be
          // the same unbounded-growth mistake packageStore.ts was built to avoid.
          if (openMissionId) await structuredEvidenceStoreRef.current?.clear(openMissionId);
        }
      },
      addStructuredEvidence: async (result) => {
        const m = orchestrator.getSnapshot().mission;
        if (!m) return;
        await structuredEvidenceStoreRef.current?.merge(
          m.id, m.cell, m.commodity, result, Date.now(),
        );
      },
      closeMission: () => orchestrator.closeMission(),
      cancelChosenTarget: () => orchestrator.cancelChosenTarget(),
      notePhotoUploaded: async (photoId, r2Key) => {
        const store = waypointStoreRef.current;
        if (!store) return;
        const owner = store.all().find((w) => w.photos.some((p) => p.id === photoId));
        // Already recorded, or not ours: nothing to do. Writing unconditionally
        // would persist the whole store on every uploaded photograph.
        if (!owner) return;
        const photo = owner.photos.find((p) => p.id === photoId);
        if (!photo || photo.remotePath === r2Key) return;
        await store.put({
          ...owner,
          photos: owner.photos.map((p) => (p.id === photoId ? { ...p, remotePath: r2Key } : p)),
        });
      },
    },
  };

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useExploration(): ExplorationApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useExploration must be used within ExplorationProvider");
  return v;
}

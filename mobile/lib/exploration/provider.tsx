// Exploration Mode — React binding (Stage E4).
//
// Mirrors the Phase 1 FieldSessionProvider pattern: mounted LOCALLY by the
// screen that needs it, never in the root layout, so the engine exists only
// while its screen does and unmount runs a full teardown.
//
// The orchestrator throttles itself (re-targeting is event-driven, not per-fix),
// so this layer re-renders at the rate the sensors already gate.
import React, { createContext, useContext, useEffect, useRef, useSyncExternalStore } from "react";
import { FieldSessionController } from "../field/sessionController";
import { PackStore, createBundledPackSource } from "../geo/packStore.ts";
import { OfflineGeoContextService } from "../geo/offlineGeoContext.ts";
import { TargetingEngine } from "../geo/targeting.ts";
import { ExplorationOrchestrator, type ExplorationSnapshot } from "./orchestrator.ts";
import type { Waypoint, WaypointType } from "../field/waypointTypes";
import type { RegionalTarget } from "../geo/expedition.ts";
import { loadBundledPackFiles } from "../geo/bundledPack.ts";
import { WaypointStore } from "../field/waypointStore";
import { WaypointService } from "../field/waypointService";
import { makeLocalEvidenceProvider, makeWaypointEvidenceSource } from "./localEvidence.ts";

export interface ExplorationApi {
  snapshot: ExplorationSnapshot;
  orchestrator: ExplorationOrchestrator;
  /** The installed pack, for the offline map and the evidence readout. */
  packs: PackStore;
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
  actions: {
    start: () => void;
    stop: () => void;
    refresh: () => void;
    selectTarget: (cell: string) => void;
    recordEvidence: () => Promise<void>;
    captureObservation: (type: WaypointType, notes?: string) => Promise<void>;
    inspectAt: (lat: number, lng: number) => void;
    clearInspect: () => void;
    navigateTo: (lat: number, lng: number) => void;
    /** Navigate to a mapped pack feature at any distance — see orchestrator. */
    navigateToRegional: (target: RegionalTarget) => void;
    clearDestination: () => void;
  };
}

const Ctx = createContext<ExplorationApi | null>(null);

/** Stable empty array: a fresh [] on each read would loop useSyncExternalStore. */
const EMPTY_WAYPOINTS: readonly Waypoint[] = [];

export function ExplorationProvider({ children }: { children: React.ReactNode }) {
  const waypointStoreRef = useRef<WaypointStore | null>(null);
  const ref = useRef<ExplorationOrchestrator | null>(null);
  const packsRef = useRef<PackStore | null>(null);
  if (ref.current == null) {
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
    ref.current = new ExplorationOrchestrator({
      field,
      targeting: new TargetingEngine(geo, localEvidence, () => packs.getData()),
      packs,
      waypoints,
    });
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

  useEffect(() => () => orchestrator.destroy(), [orchestrator]);

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
    waypoints: waypointPins,
    waypointRecords: waypoints,
    actions: {
      start: () => orchestrator.start(),
      stop: () => orchestrator.stop(),
      refresh: () => orchestrator.refresh(),
      selectTarget: (cell) => orchestrator.selectTarget(cell),
      recordEvidence: () => orchestrator.recordEvidence(),
      captureObservation: (type, notes) => orchestrator.captureObservation(type, notes),
      inspectAt: (lat, lng) => orchestrator.inspectAt(lat, lng),
      clearInspect: () => orchestrator.clearInspect(),
      navigateTo: (lat, lng) => orchestrator.navigateTo(lat, lng),
      navigateToRegional: (target) => orchestrator.navigateToRegional(target),
      clearDestination: () => orchestrator.clearDestination(),
    },
  };

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useExploration(): ExplorationApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useExploration must be used within ExplorationProvider");
  return v;
}

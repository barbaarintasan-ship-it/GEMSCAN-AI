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
import type { WaypointType } from "../field/waypointTypes";
import { loadBundledPackFiles } from "../geo/bundledPack.ts";
import { WaypointStore } from "../field/waypointStore";
import { WaypointService } from "../field/waypointService";
import { makeLocalEvidenceProvider, makeWaypointEvidenceSource } from "./localEvidence.ts";

export interface ExplorationApi {
  snapshot: ExplorationSnapshot;
  orchestrator: ExplorationOrchestrator;
  /** The installed pack, for the offline map and the evidence readout. */
  packs: PackStore;
  actions: {
    start: () => void;
    stop: () => void;
    refresh: () => void;
    selectTarget: (cell: string) => void;
    recordEvidence: () => Promise<void>;
    captureObservation: (type: WaypointType, notes?: string) => Promise<void>;
    inspectAt: (lat: number, lng: number) => void;
    clearInspect: () => void;
  };
}

const Ctx = createContext<ExplorationApi | null>(null);

export function ExplorationProvider({ children }: { children: React.ReactNode }) {
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

  const snapshot = useSyncExternalStore(
    (cb) => orchestrator.subscribe(cb),
    () => orchestrator.getSnapshot(),
  );

  useEffect(() => () => orchestrator.destroy(), [orchestrator]);

  const api: ExplorationApi = {
    snapshot,
    orchestrator,
    packs: packsRef.current!,
    actions: {
      start: () => orchestrator.start(),
      stop: () => orchestrator.stop(),
      refresh: () => orchestrator.refresh(),
      selectTarget: (cell) => orchestrator.selectTarget(cell),
      recordEvidence: () => orchestrator.recordEvidence(),
      captureObservation: (type, notes) => orchestrator.captureObservation(type, notes),
      inspectAt: (lat, lng) => orchestrator.inspectAt(lat, lng),
      clearInspect: () => orchestrator.clearInspect(),
    },
  };

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useExploration(): ExplorationApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useExploration must be used within ExplorationProvider");
  return v;
}

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
import { loadBundledPackFiles } from "../geo/bundledPack.ts";

export interface ExplorationApi {
  snapshot: ExplorationSnapshot;
  orchestrator: ExplorationOrchestrator;
  actions: {
    start: () => void;
    stop: () => void;
    refresh: () => void;
    selectTarget: (cell: string) => void;
    recordEvidence: () => Promise<void>;
  };
}

const Ctx = createContext<ExplorationApi | null>(null);

export function ExplorationProvider({ children }: { children: React.ReactNode }) {
  const ref = useRef<ExplorationOrchestrator | null>(null);
  if (ref.current == null) {
    // One graph per mounted provider; never rebuilt across re-renders.
    const packs = new PackStore(createBundledPackSource(loadBundledPackFiles));
    const targeting = new TargetingEngine(new OfflineGeoContextService(packs));
    ref.current = new ExplorationOrchestrator({
      field: new FieldSessionController(),
      targeting,
      packs,
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
    actions: {
      start: () => orchestrator.start(),
      stop: () => orchestrator.stop(),
      refresh: () => orchestrator.refresh(),
      selectTarget: (cell) => orchestrator.selectTarget(cell),
      recordEvidence: () => orchestrator.recordEvidence(),
    },
  };

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useExploration(): ExplorationApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useExploration must be used within ExplorationProvider");
  return v;
}

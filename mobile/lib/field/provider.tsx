// Field Exploration Engine — React binding (Phase 1, spec Part 2).
//
// Thin Context over one FieldSessionController instance. Mounted LOCALLY where
// needed (the debug surface in P1) — deliberately NOT in app/_layout.tsx, so
// the engine exists only while its screen does, and unmount runs destroy()
// (the belt-and-braces cleanup path). Sensor throttling happened before the
// controller dispatches, so this layer re-renders at ≤2 Hz worst case.
import React, { createContext, useContext, useEffect, useRef, useSyncExternalStore } from "react";
import { FieldSessionController } from "./sessionController";
import type { SessionSnapshot } from "./types";

export interface FieldSessionApi {
  snapshot: SessionSnapshot;
  controller: FieldSessionController;
  actions: {
    start: () => void;
    pause: () => void;
    resume: () => void;
    stop: () => void;
    retry: () => void;
    dismiss: () => void;
  };
}

const Ctx = createContext<FieldSessionApi | null>(null);

export function FieldSessionProvider({ children }: { children: React.ReactNode }) {
  // One controller per mounted provider; never recreated across re-renders.
  const ref = useRef<FieldSessionController | null>(null);
  ref.current ??= new FieldSessionController();
  const controller = ref.current;

  const snapshot = useSyncExternalStore(
    (cb) => controller.subscribe(cb),
    () => controller.getSnapshot(),
  );

  // Unmount ⇒ full teardown regardless of state (spec Part 3 cleanup).
  useEffect(() => () => controller.destroy(), [controller]);

  const api: FieldSessionApi = {
    snapshot,
    controller,
    actions: {
      start: () => controller.start(),
      pause: () => controller.pause(),
      resume: () => controller.resume(),
      stop: () => controller.stop(),
      retry: () => controller.retry(),
      dismiss: () => controller.dismiss(),
    },
  };

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useFieldSession(): FieldSessionApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useFieldSession must be used within FieldSessionProvider");
  return v;
}

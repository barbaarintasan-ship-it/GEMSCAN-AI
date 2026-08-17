// The one local sample store, and the hook that drains it.
//
// A single instance, because three places need the SAME records: the capture
// screen that writes them, the collection that lists them, and the sync that
// files them. Two stores would mean a sample saved by one and invisible to the
// other — which is the failure this whole feature exists to prevent.
//
// Module-level rather than a provider: the collection is reachable without the
// exploration session, and the sync must keep working while neither screen is
// open. Same pattern as lib/captureHandoff.
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { LocalSampleStore } from "./localSampleStore";
import { pushPendingSamples } from "./pendingSampleSync";
import { useIsOnline } from "../network";
import { markPhase } from "../diagnostics/jsStall";

let instance: LocalSampleStore | null = null;

export function localSamples(): LocalSampleStore {
  instance ??= new LocalSampleStore();
  return instance;
}

/** How often a signed-in device retries what it is still holding. */
const DRAIN_INTERVAL_MS = 90_000;

export interface SampleSyncState {
  /** Samples taken on this device that the server has not accepted yet. */
  pending: number;
  /** ...of which this many have failed at least once. */
  failed: number;
  uploading: boolean;
}

/**
 * Files whatever the device is holding, whenever it can.
 *
 * Mounted by the screens that care (the collection, the map workspace). It never
 * surfaces an error: a sample that cannot be filed is not a failure the
 * geologist has to handle, it is a sample the device is still holding.
 */
export function useSampleSync(): SampleSyncState {
  const store = localSamples();
  const isOnline = useIsOnline();
  const [state, setState] = useState<SampleSyncState>({ pending: 0, failed: 0, uploading: false });
  const busy = useRef(false);

  useEffect(() => {
    const read = () => {
      const s = store.stats();
      setState((prev) =>
        prev.pending === s.pending && prev.failed === s.failed
          ? prev
          : { ...prev, pending: s.pending, failed: s.failed });
    };
    const off = store.subscribe(read);
    void store.load().then(read);
    return off;
  }, [store]);

  useEffect(() => {
    let alive = true;

    const drain = async () => {
      if (!alive || busy.current || !isOnline) return;
      // INVESTIGATION: same class of check as expeditionSync.drain — this fires
      // on its own DRAIN_INTERVAL_MS=90_000 timer, mounted at the map workspace
      // root (workspace.tsx), so it runs regardless of screen. Its own upload
      // path (pendingSampleSync -> enterpriseSamples.uploadSampleMedia) reads a
      // photo and base64-encodes it with no timeout at all, unlike the six fixed
      // call sites — a real candidate for sustained CPU + large allocations.
      const doneDrain = markPhase(`sampleSync.drain[${store.pending().length}]`);
      try {
      await store.load();
      if (store.pending().length === 0) return;
      busy.current = true;
      setState((s) => ({ ...s, uploading: true }));
      try {
        await pushPendingSamples(store, isOnline);
      } finally {
        busy.current = false;
        if (alive) {
          const s = store.stats();
          setState({ pending: s.pending, failed: s.failed, uploading: false });
        }
      }
      } finally {
        doneDrain();
      }
    };

    // Now (the connection may have just returned), on a slow timer, and when the
    // app comes back to the foreground.
    void drain();
    const timer = setInterval(() => void drain(), DRAIN_INTERVAL_MS);
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") void drain(); });

    return () => { alive = false; clearInterval(timer); sub.remove(); };
  }, [isOnline, store]);

  return state;
}

// Connectivity detection — used by history.tsx, collection-map.tsx, and
// scan/results.tsx to decide whether to attempt a live refresh or fall back
// to whatever's already cached (see lib/offlineCache.ts).
import { useEffect, useState } from "react";
import NetInfo from "@react-native-community/netinfo";

// Optimistic default (true): on the very first render, before NetInfo's
// first event fires, callers should still attempt a live fetch rather than
// assume offline — an actual network failure is handled by the existing
// error paths regardless.
export function useIsOnline(): boolean {
  const [isOnline, setIsOnline] = useState(true);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      setIsOnline(state.isConnected !== false && state.isInternetReachable !== false);
    });
    return () => unsubscribe();
  }, []);

  return isOnline;
}

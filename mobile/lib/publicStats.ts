// usePublicStats
//
// Read-only, AGGREGATE community counters shown in the home-screen footer:
// how many people have registered, and how many scans produced a CONFIRMED
// valuable identification. No personal data — just two totals from the
// gemscan_public_stats() SQL function (migration 0007), which is safe to call
// with the anon key. Cached so it never spams the backend.
import { useEffect, useState } from "react";
import { InteractionManager } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "./supabase";
import { withTimeout } from "./withTimeout";
import { markPhase } from "./diagnostics/jsStall";

export type PublicStats = {
  registeredUsers: number;
  confirmedGems: number;
};

/**
 * Another unguarded cold-start call, the same class as getSession(),
 * appUpdate.check, subscription.fetch and the tile downloads: no timeout of
 * its own, and — unlike subscription, which waits for a session — this one
 * fires the instant the home screen mounts, session or not, because it reads
 * with the anon key. Same fix: fail open rather than hang; react-query's
 * own `retry: 1` and staleTime pick it back up on the next mount or refetch.
 */
const PUBLIC_STATS_TIMEOUT_MS = 10_000;
const TIMED_OUT = Symbol("public stats fetch timed out");

export async function fetchPublicStats(): Promise<PublicStats> {
  const done = markPhase("publicStats.fetch");
  // Promise.resolve(...) coerces the query builder (a thenable, not a real
  // Promise) into one withTimeout can race against.
  const result = await withTimeout<Awaited<ReturnType<typeof supabase.rpc>> | typeof TIMED_OUT>(
    Promise.resolve(supabase.rpc("gemscan_public_stats")),
    PUBLIC_STATS_TIMEOUT_MS,
    TIMED_OUT,
  );
  done();
  if (result === TIMED_OUT) return { registeredUsers: 0, confirmedGems: 0 };
  const { data, error } = result;
  if (error) throw error;
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    registeredUsers: Number(row.registered_users ?? 0),
    confirmedGems: Number(row.confirmed_gems ?? 0),
  };
}

/**
 * Deferred past the first paint. CommunityStats renders nothing until `data`
 * arrives regardless (see its own comment — "never flashes zeros"), so this
 * cosmetic footer widget has nothing to lose by starting a beat later. What it
 * DOES buy: on a cold boot this call used to fire in the same instant as
 * auth.getSession, subscription.fetch and appUpdate.check — four network
 * calls racing at once. MEASURED on a device: publicStats.fetch alone still
 * open 4-5+ seconds after boot, entangled with the others in the jsStall log.
 * Deferring it thins that opening burst without changing what it fetches,
 * how long it is allowed to take (PUBLIC_STATS_TIMEOUT_MS, untouched), or its
 * fallback on failure.
 */
export function usePublicStats() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => setEnabled(true));
    return () => task.cancel();
  }, []);
  return useQuery({
    queryKey: ["public-stats"],
    queryFn: fetchPublicStats,
    staleTime: 5 * 60 * 1000, // 5 min — community totals move slowly.
    gcTime: 30 * 60 * 1000,
    retry: 1,
    enabled,
  });
}

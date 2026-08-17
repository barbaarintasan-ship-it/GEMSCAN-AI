// usePublicStats
//
// Read-only, AGGREGATE community counters shown in the home-screen footer:
// how many people have registered, and how many scans produced a CONFIRMED
// valuable identification. No personal data — just two totals from the
// gemscan_public_stats() SQL function (migration 0007), which is safe to call
// with the anon key. Cached so it never spams the backend.
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

export function usePublicStats() {
  return useQuery({
    queryKey: ["public-stats"],
    queryFn: fetchPublicStats,
    staleTime: 5 * 60 * 1000, // 5 min — community totals move slowly.
    gcTime: 30 * 60 * 1000,
    retry: 1,
  });
}

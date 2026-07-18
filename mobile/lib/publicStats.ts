// usePublicStats
//
// Read-only, AGGREGATE community counters shown in the home-screen footer:
// how many people have registered, and how many scans produced a CONFIRMED
// valuable identification. No personal data — just two totals from the
// gemscan_public_stats() SQL function (migration 0007), which is safe to call
// with the anon key. Cached so it never spams the backend.
import { useQuery } from "@tanstack/react-query";
import { supabase } from "./supabase";

export type PublicStats = {
  registeredUsers: number;
  confirmedGems: number;
};

async function fetchPublicStats(): Promise<PublicStats> {
  const { data, error } = await supabase.rpc("gemscan_public_stats");
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

// Production cache adapter over geo.geocontext_cache (service-only table). Used by
// the geocontext Edge Function with a service-role client.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import type { CacheStore, GeoContext } from "./types.ts";

export function makeSupabaseCacheStore(client: SupabaseClient<any, any>): CacheStore {
  const tbl = () => client.schema("geo").from("geocontext_cache");
  return {
    async get(h3, engineVersion): Promise<GeoContext | null> {
      const { data, error } = await tbl()
        .select("payload, expires_at")
        .eq("h3", h3)
        .eq("engine_version", engineVersion)
        .maybeSingle();
      if (error || !data) return null;
      if (data.expires_at && new Date(data.expires_at as string) <= new Date()) return null;
      return data.payload as GeoContext;
    },
    async set(h3, engineVersion, ctx, ttlSeconds): Promise<void> {
      const expires_at = ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : null;
      const { error } = await tbl().upsert(
        {
          h3, engine_version: engineVersion, payload: ctx,
          resolution: ctx.location.h3 ? null : null, computed_at: new Date().toISOString(), expires_at,
        },
        { onConflict: "h3,engine_version" },
      );
      if (error) throw new Error(`cache set: ${error.message}`);
    },
  };
}

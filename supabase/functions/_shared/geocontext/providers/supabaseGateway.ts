// Production data gateway — supabase-js .rpc() over PostgREST (geo schema), calling
// the 0058 spatial RPC functions. Used by the deployed geocontext Edge Function.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import type {
  AssemblageRuleRow, AssociationRow, CommodityProfileRow, CommunityRow, GeoDataGateway,
  GeologyRow, KnowledgeRow, KnowledgeRuleRow, OccurrenceRow, StructuralFeatureRow,
} from "./gateway.ts";

export function makeSupabaseGateway(client: SupabaseClient<any, any>): GeoDataGateway {
  const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T[]> => {
    const { data, error } = await client.schema("geo").rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return (data ?? []) as T[];
  };
  return {
    geologyAt: (lat, lng) => rpc<GeologyRow>("geology_at", { p_lat: lat, p_lng: lng }),
    occurrencesNear: (lat, lng, r) => rpc<OccurrenceRow>("occurrences_near", { p_lat: lat, p_lng: lng, p_radius_m: r }),
    knowledgeNear: (lat, lng, r) => rpc<KnowledgeRow>("knowledge_near", { p_lat: lat, p_lng: lng, p_radius_m: r }),
    communityNear: async (lat, lng, r) => {
      const rows = await rpc<CommunityRow>("community_near", { p_lat: lat, p_lng: lng, p_radius_m: r });
      return rows[0] ?? { verified_scans: 0, sample_count: 0, cell_count: 0 };
    },
    associationsForHostRocks: (codes) => rpc<AssociationRow>("associations_for_host_rocks", { p_host_rock_codes: codes }),
    knowledgeRulesFor: (keys) => rpc<KnowledgeRuleRow>("knowledge_rules_for", {
      p_host_rocks: keys.hostRocks, p_lithology: keys.lithology, p_deposit_types: keys.depositTypes,
    }),
    commodityProfiles: (codes) => rpc<CommodityProfileRow>("commodity_profiles", { p_codes: codes }),
    assemblageRulesFor: (minerals) => rpc<AssemblageRuleRow>("assemblage_rules_for", { p_minerals: minerals }),
    structuralFeaturesNear: (lat, lng, r) => rpc<StructuralFeatureRow>("structural_features_near", { p_lat: lat, p_lng: lng, p_radius_m: r }),
  };
}

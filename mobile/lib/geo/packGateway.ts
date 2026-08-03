// PackGateway — GeoDataGateway backed by an offline knowledge pack (Stage E2).
//
// The device counterpart of supabaseGateway.ts. Providers depend on the
// GeoDataGateway INTERFACE, not on a transport, so all 7 of them run unchanged
// against this (Architecture §7.3): the same reasoning, different data source.
//
// Every method here mirrors a SQL function in migrations 0058 / 0090. Where the
// SQL has an ordering or a matching rule, this reproduces it exactly — including
// Postgres's NULLS FIRST on `order by … desc`, which is easy to miss and would
// otherwise reorder evidence and change which items a provider reports first.
import {
  bboxContains,
  bboxPadding,
  haversineM,
  pointInRings,
  type Ring,
} from "../../../shared/geo-core/geo/spatial.ts";
import { emptyPackData } from "../../../shared/geo-core/pack/read.ts";
import type { PackData } from "../../../shared/geo-core/pack/types.ts";
import type {
  AssemblageRuleRow,
  AssociationRow,
  CommodityProfileRow,
  CommunityRow,
  GeoDataGateway,
  GeologyRow,
  KnowledgeRow,
  KnowledgeRuleRow,
  OccurrenceRow,
  StructuralFeatureRow,
} from "../../../supabase/functions/_shared/geocontext/providers/gateway.ts";

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * Postgres `order by <col> desc` puts NULLs FIRST. Mirroring that keeps the
 * device's evidence order identical to the server's, which the E3 differential
 * suite asserts exactly (provider contribution ordering has zero tolerance).
 */
function byWeightDescNullsFirst<T extends { weight: number | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.weight == null && b.weight == null) return 0;
    if (a.weight == null) return -1;
    if (b.weight == null) return 1;
    return b.weight - a.weight;
  });
}

/**
 * Candidate points within `radiusM`, nearest first — the shared body of every
 * ST_DWithin + ST_Distance method. The bbox prefilter is an optimisation only:
 * the exact haversine test still decides membership.
 */
function near<T extends { lat: number; lng: number }>(
  rows: T[],
  lat: number,
  lng: number,
  radiusM: number,
): Array<{ row: T; distanceM: number }> {
  const { dLat, dLng } = bboxPadding(lat, radiusM);
  const out: Array<{ row: T; distanceM: number }> = [];
  for (const row of rows) {
    if (Math.abs(row.lat - lat) > dLat || Math.abs(row.lng - lng) > dLng) continue;
    const distanceM = haversineM({ lat, lng }, { lat: row.lat, lng: row.lng });
    if (distanceM <= radiusM) out.push({ row, distanceM });
  }
  out.sort((a, b) => a.distanceM - b.distanceM);
  return out;
}

/**
 * Build a gateway over pack data. With no pack installed the data is empty and
 * every method returns nothing — the app then says it has no knowledge here
 * (Architecture §3.9). It never extrapolates.
 */
export function makePackGateway(data: PackData = emptyPackData()): GeoDataGateway {
  return {
    // geo.geology_at — ST_Intersects(polygon, point).
    async geologyAt(lat, lng): Promise<GeologyRow[]> {
      return data.geology
        .filter((u) =>
          u.isPolygon &&
          bboxContains(u.bbox, lng, lat) &&
          pointInRings(u.rings as Ring[], lng, lat)
        )
        .map((u) => ({
          id: u.id,
          name: u.name,
          kind: u.kind,
          source: u.source,
          attributes: u.attributes,
        }));
    },

    // geo.occurrences_near — order by distance_m.
    async occurrencesNear(lat, lng, radiusM): Promise<OccurrenceRow[]> {
      return near(data.occurrences, lat, lng, radiusM).map(({ row, distanceM }) => ({
        id: row.id,
        name: row.name,
        commodity_key: row.commodity_key,
        deposit_type: row.deposit_type,
        host_rocks: row.host_rocks,
        distance_m: distanceM,
        dataset_id: row.dataset_id,
        source: row.source,
        version: row.version,
        reference: row.reference,
      }));
    },

    // geo.knowledge_near — order by distance_m.
    async knowledgeNear(lat, lng, radiusM): Promise<KnowledgeRow[]> {
      return near(data.knowledge, lat, lng, radiusM).map(({ row, distanceM }) => ({
        id: row.id,
        kind: row.kind,
        statement: row.statement,
        commodity_key: row.commodity_key,
        host_rock_key: row.host_rock_key,
        tier: row.tier,
        page: row.page,
        distance_m: distanceM,
        source_title: row.source_title,
        dataset_id: row.dataset_id,
        dataset_source: row.dataset_source,
        dataset_version: row.dataset_version,
      }));
    },

    // geo.community_near — one aggregate row over the cells in range.
    async communityNear(lat, lng, radiusM): Promise<CommunityRow> {
      const hits = near(data.community, lat, lng, radiusM);
      let verified = 0;
      let samples = 0;
      for (const { row } of hits) {
        verified += row.verified_scans;
        samples += row.sample_count;
      }
      return { verified_scans: verified, sample_count: samples, cell_count: hits.length };
    },

    // geo.associations_for_host_rocks — exact code match, as in SQL.
    async associationsForHostRocks(codes): Promise<AssociationRow[]> {
      const wanted = new Set(codes);
      return data.associations
        .filter((a) => wanted.has(a.host_rock_code))
        .map((a) => ({ ...a }));
    },

    // geo.knowledge_rules_for — antecedent_key matched case-insensitively
    // against the union of the three key lists, blanks dropped; weight desc.
    async knowledgeRulesFor(keys): Promise<KnowledgeRuleRow[]> {
      const wanted = new Set(
        [...(keys.hostRocks ?? []), ...(keys.lithology ?? []), ...(keys.depositTypes ?? [])]
          .filter((k) => k != null && k.trim() !== "")
          .map(norm),
      );
      if (wanted.size === 0) return [];
      return byWeightDescNullsFirst(
        data.rules.filter((r) => wanted.has(norm(r.antecedent_key))),
      ).map((r) => ({ ...r }));
    },

    // geo.commodity_profiles — exact code match (the SQL does NOT lower-case).
    async commodityProfiles(codes): Promise<CommodityProfileRow[]> {
      const wanted = new Set(codes);
      return data.commodities.filter((c) => wanted.has(c.code)).map((c) => ({ ...c }));
    },

    // geo.assemblage_rules_for — `r.minerals <@ observed`: the rule's mineral
    // set must be a SUBSET of what was observed, not merely overlap it.
    async assemblageRulesFor(minerals): Promise<AssemblageRuleRow[]> {
      const observed = new Set((minerals ?? []).map(norm));
      return byWeightDescNullsFirst(
        data.assemblages.filter((r) => r.minerals.every((m) => observed.has(norm(m)))),
      ).map((r) => ({ ...r }));
    },

    // geo.structural_features_near — dormant until structural data is loaded.
    async structuralFeaturesNear(lat, lng, radiusM): Promise<StructuralFeatureRow[]> {
      return near(data.structures, lat, lng, radiusM).map(({ row, distanceM }) => ({
        id: row.id,
        feature_type: row.feature_type,
        name: row.name,
        distance_m: distanceM,
        attributes: row.attributes,
      }));
    },
  };
}

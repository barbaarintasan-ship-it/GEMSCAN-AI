// End-to-end integration test: ALL providers enabled against the shadow database.
//
// Uses a direct Postgres connection (deno-postgres) implementing the same
// GeoDataGateway + CacheStore the production Supabase gateway implements — so the
// real providers + engine + 0058 RPCs + geo tables + geocontext_cache are exercised
// against live data, independent of the (flaky local) PostgREST stack. Everything
// runs inside one transaction and is rolled back.
//
// Run: deno test --no-check --allow-net --allow-env supabase/functions/_shared/geocontext/e2e.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { GeoContextEngine } from "./engine.ts";
import { buildProviders } from "./providers/index.ts";
import type { CacheStore, GeoContext } from "./types.ts";
import type {
  AssociationRow, CommunityRow, GeoDataGateway, GeologyRow, KnowledgeRow, OccurrenceRow,
} from "./providers/gateway.ts";

function pgGateway(c: Client): GeoDataGateway {
  const rows = async <T>(sql: string, args: unknown[]): Promise<T[]> =>
    (await c.queryObject<T>(sql, args)).rows;
  return {
    geologyAt: (lat, lng) => rows<GeologyRow>("select * from geo.geology_at($1,$2)", [lat, lng]),
    occurrencesNear: (lat, lng, r) => rows<OccurrenceRow>("select * from geo.occurrences_near($1,$2,$3)", [lat, lng, r]),
    knowledgeNear: (lat, lng, r) => rows<KnowledgeRow>("select * from geo.knowledge_near($1,$2,$3)", [lat, lng, r]),
    communityNear: async (lat, lng, r) => {
      const rr = await rows<CommunityRow>("select * from geo.community_near($1,$2,$3)", [lat, lng, r]);
      return rr[0] ?? { verified_scans: 0, sample_count: 0, cell_count: 0 };
    },
    associationsForHostRocks: (codes) =>
      rows<AssociationRow>("select * from geo.associations_for_host_rocks($1)", [codes]),
    knowledgeRulesFor: (k) =>
      rows("select * from geo.knowledge_rules_for($1,$2,$3)", [k.hostRocks, k.lithology, k.depositTypes]) as never,
    commodityProfiles: (codes) => rows("select * from geo.commodity_profiles($1)", [codes]) as never,
    assemblageRulesFor: (minerals) => rows("select * from geo.assemblage_rules_for($1)", [minerals]) as never,
    structuralFeaturesNear: (lat, lng, r) =>
      rows("select * from geo.structural_features_near($1,$2,$3)", [lat, lng, r]) as never,
  };
}

function pgCacheStore(c: Client): CacheStore {
  return {
    async get(h3, v) {
      const r = await c.queryObject<{ payload: GeoContext; expires_at: string | null }>(
        "select payload, expires_at from geo.geocontext_cache where h3=$1 and engine_version=$2", [h3, v]);
      const row = r.rows[0];
      if (!row) return null;
      if (row.expires_at && new Date(row.expires_at) <= new Date()) return null;
      return row.payload;
    },
    async set(h3, v, ctx, ttl) {
      const expires = ttl ? new Date(Date.now() + ttl * 1000).toISOString() : null;
      await c.queryObject(
        `insert into geo.geocontext_cache (h3, engine_version, payload, expires_at)
         values ($1,$2,$3,$4)
         on conflict (h3, engine_version) do update set payload=excluded.payload, expires_at=excluded.expires_at`,
        [h3, v, ctx, expires]);
    },
  };
}

const SEED = `
insert into geo.geological_layer (name,kind,geom,source)
  values ('Inda Ad Formation','formation',
    extensions.st_setsrid(extensions.st_geomfromtext('POLYGON((44 1,46 1,46 3,44 3,44 1))'),4326),'UNESCO');
insert into geo.dataset_registry (id,source_key,title,version) values
  ('e2e00000-0000-0000-0000-0000000000d1','usgs_mrds','USGS MRDS','2026.07'),
  ('e2e00000-0000-0000-0000-0000000000d2','greenwood','Greenwood 1982','1.0');
insert into geo.commodity (code,name) values ('Au','Gold');
insert into geo.host_rock (code,name) values ('quartz_vein','Quartz Vein');
insert into geo.mineral_association (commodity_id,host_rock_id,weight)
  select c.id,h.id,0.80 from geo.commodity c, geo.host_rock h where c.code='Au' and h.code='quartz_vein';
insert into geo.mineral_occurrence (dataset_id,external_id,name,geom,commodity_key,deposit_type,host_rocks)
  values ('e2e00000-0000-0000-0000-0000000000d1','MRDS-Au-1','Wadi Gold',
    extensions.st_setsrid(extensions.st_makepoint(45.0,2.0),4326),'Au','orogenic gold','{quartz_vein}');
insert into geo.knowledge_source (id,dataset_id,title,publication_year)
  values ('e2e00000-0000-0000-0000-00000000000a','e2e00000-0000-0000-0000-0000000000d2','Greenwood Vol I',1982);
insert into geo.geological_knowledge (source_id,kind,statement,geom,commodity_key,tier)
  values ('e2e00000-0000-0000-0000-00000000000a','geochem_anomaly','Elevated Au in stream sediment',
    extensions.st_setsrid(extensions.st_makepoint(45.01,2.01),4326),'Au','historical');
insert into enterprise.organization (id,name,status) values ('e2e00000-0000-0000-0000-00000000000b','Org','active');
insert into enterprise.project (id,name,organization_id,visibility) values ('e2e00000-0000-0000-0000-00000000000c','P','e2e00000-0000-0000-0000-00000000000b','public');
insert into enterprise.exploration_area (id,name,center,project_id)
  values ('e2e00000-0000-0000-0000-00000000000d','Area',extensions.st_setsrid(extensions.st_makepoint(45,2),4326)::extensions.geography,null);
insert into geo.coverage_cell (area_id,h3,resolution,sample_count,verified_count,geom)
  values ('e2e00000-0000-0000-0000-00000000000d','8a2a1072b59ffff',10,5,3,
    extensions.st_setsrid(extensions.st_geomfromtext('POLYGON((44.9 1.9,45.1 1.9,45.1 2.1,44.9 2.1,44.9 1.9))'),4326));
`;

Deno.test("E2E: all providers enabled against shadow DB → explainable GeoContext", async () => {
  const c = new Client({ hostname: "127.0.0.1", port: 54322, user: "postgres", password: "postgres", database: "postgres" });
  await c.connect();
  try {
    await c.queryArray("begin");
    await c.queryArray(SEED);

    const engine = new GeoContextEngine({
      engineVersion: "geocontext-e2e",
      providers: buildProviders(pgGateway(c)),
      cache: pgCacheStore(c),
      cacheTtlSeconds: 3600,
    });
    const query = { lat: 2.0, lng: 45.0, radiusM: 50000, h3: "8a2a1072b59ffff" };
    const ctx = await engine.run(query);

    // ── content from each provider ──
    assertEquals(ctx.geology.unit, "Inda Ad Formation");           // geology
    assert(ctx.knownOccurrences.length >= 1, "occurrence");        // occurrence
    assertEquals((ctx.knownOccurrences[0] as { commodity: string }).commodity, "Au");
    assert(ctx.historicalReports.length >= 1, "knowledge");        // knowledge
    assert(ctx.commodityAssociations.length >= 1, "association");  // mineral_association
    assertEquals((ctx.commodityAssociations[0] as { commodity: string }).commodity, "Au");
    assertEquals(ctx.communityEvidence.verifiedScans, 3);          // community

    // ── explainability: evidence section ──
    const provs = ctx.evidence.providers;
    assertEquals(provs.length, 5, "all 5 providers reported");
    const contributed = provs.filter((p) => p.contributed).map((p) => p.provider).sort();
    assertEquals(contributed, ["community", "geology", "knowledge", "mineral_association", "occurrence"]);
    // dataset/version IDs are surfaced for traceability
    const sources = ctx.evidence.datasets.map((d) => d.source).sort();
    assert(sources.includes("usgs_mrds"), "MRDS dataset in evidence");
    assert(sources.includes("greenwood"), "Greenwood dataset in evidence");
    assert(ctx.evidence.datasets.some((d) => d.version === "2026.07"), "dataset version surfaced");

    // ── evidence-based, never asserts presence ──
    assert(ctx.reasoningFactors.length >= 3, "reasoning factors");
    assert(["Low", "Moderate", "High"].includes(ctx.confidence.overall));
    assert(!("hasGold" in ctx));

    // ── cache: second run is a hit ──
    assertEquals(ctx.meta.cache, "miss");
    const again = await engine.run(query);
    assertEquals(again.meta.cache, "hit");
  } finally {
    await c.queryArray("rollback").catch(() => {});
    await c.end();
  }
});

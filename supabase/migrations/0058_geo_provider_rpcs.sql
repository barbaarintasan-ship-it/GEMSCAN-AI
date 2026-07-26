-- 0058_geo_provider_rpcs.sql
--
-- Luul Scan — GeoContext P1: spatial query RPC functions for the runtime providers.
--
-- PostgREST cannot express PostGIS predicates (ST_DWithin / ST_Intersects) through
-- .from().select(), so the spatial providers call these SECURITY DEFINER STABLE
-- functions via supabase-js .rpc() (Option A, PostgREST-native). Each returns the
-- exact fields a provider needs, including the dataset source/version for the
-- explainable evidence section. All PostGIS calls are schema-qualified (extensions.*).
--
-- geo schema, additive; frozen core/public untouched. Idempotent. EXECUTE granted to
-- authenticated + service_role; the functions read reference data already exposed to
-- authenticated by RLS.

-- ── 1. Geology at a point (UNESCO polygon lookup) ──────────────────────────
create or replace function geo.geology_at(p_lat double precision, p_lng double precision)
returns table (id uuid, name text, kind text, source text, attributes jsonb)
language sql stable security definer set search_path = geo, pg_temp
as $$
  select l.id, l.name, l.kind, l.source, l.attributes
  from geo.geological_layer l
  where extensions.st_intersects(
    l.geom, extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326));
$$;

-- ── 2. Mineral occurrences within radius (MRDS + extracted) ─────────────────
create or replace function geo.occurrences_near(p_lat double precision, p_lng double precision, p_radius_m double precision)
returns table (id uuid, name text, commodity_key text, deposit_type text, host_rocks text[],
               distance_m double precision, dataset_id uuid, source text, version text, reference text)
language sql stable security definer set search_path = geo, pg_temp
as $$
  select o.id, o.name, o.commodity_key, o.deposit_type, o.host_rocks,
         extensions.st_distance(o.geom::extensions.geography,
           extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography) as distance_m,
         o.dataset_id, dr.source_key, dr.version, o.reference
  from geo.mineral_occurrence o
  join geo.dataset_registry dr on dr.id = o.dataset_id
  where o.geom is not null
    and extensions.st_dwithin(o.geom::extensions.geography,
          extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography, p_radius_m)
  order by distance_m;
$$;

-- ── 3. Geological knowledge facts within radius (extracted) ────────────────
create or replace function geo.knowledge_near(p_lat double precision, p_lng double precision, p_radius_m double precision)
returns table (id uuid, kind text, statement text, commodity_key text, host_rock_key text, tier text, page integer,
               distance_m double precision, source_title text, dataset_id uuid, dataset_source text, dataset_version text)
language sql stable security definer set search_path = geo, pg_temp
as $$
  select gk.id, gk.kind, gk.statement, gk.commodity_key, gk.host_rock_key, gk.tier, gk.page,
         extensions.st_distance(gk.geom::extensions.geography,
           extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography) as distance_m,
         ks.title, ks.dataset_id, dr.source_key, dr.version
  from geo.geological_knowledge gk
  join geo.knowledge_source ks on ks.id = gk.source_id
  join geo.dataset_registry dr on dr.id = ks.dataset_id
  where gk.geom is not null
    and extensions.st_dwithin(gk.geom::extensions.geography,
          extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography, p_radius_m)
  order by distance_m;
$$;

-- ── 4. Community evidence aggregate near a point (coverage cells) ───────────
create or replace function geo.community_near(p_lat double precision, p_lng double precision, p_radius_m double precision)
returns table (verified_scans bigint, sample_count bigint, cell_count bigint)
language sql stable security definer set search_path = geo, pg_temp
as $$
  select coalesce(sum(cc.verified_count),0)::bigint, coalesce(sum(cc.sample_count),0)::bigint, count(*)::bigint
  from geo.coverage_cell cc
  where cc.geom is not null
    and extensions.st_dwithin(cc.geom::extensions.geography,
          extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography, p_radius_m);
$$;

-- ── 5. Commodity associations for a set of host-rock codes ─────────────────
create or replace function geo.associations_for_host_rocks(p_host_rock_codes text[])
returns table (commodity_code text, host_rock_code text, weight numeric)
language sql stable security definer set search_path = geo, pg_temp
as $$
  select c.code, h.code, a.weight
  from geo.mineral_association a
  join geo.commodity c on c.id = a.commodity_id
  join geo.host_rock h on h.id = a.host_rock_id
  where h.code = any(p_host_rock_codes);
$$;

-- ── Grants ─────────────────────────────────────────────────────────────────
grant execute on function geo.geology_at(double precision, double precision) to authenticated, service_role;
grant execute on function geo.occurrences_near(double precision, double precision, double precision) to authenticated, service_role;
grant execute on function geo.knowledge_near(double precision, double precision, double precision) to authenticated, service_role;
grant execute on function geo.community_near(double precision, double precision, double precision) to authenticated, service_role;
grant execute on function geo.associations_for_host_rocks(text[]) to authenticated, service_role;

-- ── VERIFY (CI/CD) — expect: fns=5 ─────────────────────────────────────────
--   select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--   where n.nspname='geo' and p.proname in
--     ('geology_at','occurrences_near','knowledge_near','community_near','associations_for_host_rocks');

-- ── ROLLBACK (down-path) ───────────────────────────────────────────────────
--   drop function if exists geo.geology_at(double precision, double precision);
--   drop function if exists geo.occurrences_near(double precision, double precision, double precision);
--   drop function if exists geo.knowledge_near(double precision, double precision, double precision);
--   drop function if exists geo.community_near(double precision, double precision, double precision);
--   drop function if exists geo.associations_for_host_rocks(text[]);

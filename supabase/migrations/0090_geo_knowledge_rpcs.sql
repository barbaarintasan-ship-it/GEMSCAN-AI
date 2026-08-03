-- 0090_geo_knowledge_rpcs.sql
--
-- EMIE — the RPCs the new knowledge providers read through (same security-definer
-- pattern as 0058). All are read-only, case-insensitive, and return the KB rows the
-- provider turns into evidence. structural_features_near returns nothing until
-- geo.structural_feature is populated (the Structural Geology Provider stays dormant).

-- Rock / lithology / deposit-type → knowledge rules. antecedent_key is matched
-- case-insensitively against the union of all provided keys.
create or replace function geo.knowledge_rules_for(
  p_host_rocks text[], p_lithology text[], p_deposit_types text[]
) returns setof geo.geo_knowledge_rule
language sql stable security definer set search_path = geo, pg_temp as $$
  select r.* from geo.geo_knowledge_rule r
  where lower(r.antecedent_key) = any (
    select lower(x) from unnest(
      coalesce(p_host_rocks,'{}') || coalesce(p_lithology,'{}') || coalesce(p_deposit_types,'{}')
    ) as x
    where btrim(x) <> ''
  )
  order by r.weight desc;
$$;

-- Commodity profiles by code.
create or replace function geo.commodity_profiles(p_codes text[])
returns setof geo.commodity_profile
language sql stable security definer set search_path = geo, pg_temp as $$
  select c.* from geo.commodity_profile c where c.code = any(coalesce(p_codes,'{}'));
$$;

-- Assemblage rules whose mineral set is fully contained in the observed minerals.
create or replace function geo.assemblage_rules_for(p_minerals text[])
returns setof geo.mineral_assemblage_rule
language sql stable security definer set search_path = geo, pg_temp as $$
  select r.* from geo.mineral_assemblage_rule r
  where r.minerals <@ (
    select coalesce(array_agg(lower(btrim(x))), '{}') from unnest(coalesce(p_minerals,'{}')) as x
  )
  order by r.weight desc;
$$;

-- Structural features within radius. Empty until geo.structural_feature is loaded.
create or replace function geo.structural_features_near(
  p_lat double precision, p_lng double precision, p_radius_m double precision
) returns table(id uuid, feature_type text, name text, distance_m double precision, attributes jsonb)
language sql stable security definer set search_path = geo, extensions, pg_temp as $$
  select f.id, f.feature_type, f.name,
    extensions.st_distance(f.geom,
      extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography) as distance_m,
    f.attributes
  from geo.structural_feature f
  where extensions.st_dwithin(f.geom,
    extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography, p_radius_m)
  order by distance_m asc;
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
grant execute on function geo.knowledge_rules_for(text[], text[], text[]) to authenticated, service_role;
grant execute on function geo.commodity_profiles(text[]) to authenticated, service_role;
grant execute on function geo.assemblage_rules_for(text[]) to authenticated, service_role;
grant execute on function geo.structural_features_near(double precision, double precision, double precision) to authenticated, service_role;

-- ── VERIFY ── expect 4 functions ────────────────────────────────────────────
--   select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--   where n.nspname='geo' and p.proname in
--     ('knowledge_rules_for','commodity_profiles','assemblage_rules_for','structural_features_near'); -- 4

-- ── ROLLBACK ──
--   drop function if exists geo.knowledge_rules_for(text[], text[], text[]);
--   drop function if exists geo.commodity_profiles(text[]);
--   drop function if exists geo.assemblage_rules_for(text[]);
--   drop function if exists geo.structural_features_near(double precision, double precision, double precision);

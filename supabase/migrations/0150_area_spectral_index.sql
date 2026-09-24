-- 0150_area_spectral_index.sql
--
-- Phase 16 (Geological Intelligence Transformation) — Remote-Sensing Spectral
-- Intelligence, first real spectral product: Iron Oxide Ratio (B04/B02),
-- computed server-side from Sentinel-2 L2A via the Copernicus Data Space
-- Ecosystem Statistical API. Classic gossan/hydrothermal-alteration indicator
-- — directly matches the "gossan"/"iron stain"/"hematite" diagnostic
-- observations shared/geo-core already looks for (coreCommodityModel.ts).
--
-- ONE new table. No change to exploration_area, mission_assignment or any
-- scoring path. `value` here is NEVER read by TargetingEngine/
-- prospectivityEvidence — it is surfaced to a human via get_target_report
-- (0151) as its own labelled section, not folded into `target.score` or
-- `target.reasons`. See area-spectral-index/handler.ts's header note for the
-- full authorization/quota/date-selection rationale.
--
-- AUTHORIZATION: is_mission_member(mission_id) for reads — same read
-- boundary as compare_mission_areas/area_geological_analogues/
-- get_target_report. Writes are service-role only (the edge function calls
-- Sentinel Hub with server-side secrets; nothing here is client-writable).

create table if not exists enterprise.area_spectral_index (
  id                    uuid primary key default gen_random_uuid(),
  mission_id            uuid not null references enterprise.exploration_mission(id) on delete cascade,
  area_id               uuid not null references enterprise.exploration_area(id) on delete cascade,
  index_name            text not null default 'iron_oxide_ratio',
  value                 numeric,
  acquisition_date      date not null,
  cloud_fraction        numeric,
  valid_pixel_fraction  numeric,
  resolution_m          numeric not null default 10,
  source                text not null default 'Sentinel-2 L2A (Copernicus Data Space Ecosystem)',
  raw                   jsonb,
  computed_by           uuid references auth.users(id),
  computed_at           timestamptz not null default now(),
  unique (area_id, index_name, acquisition_date)
);

alter table enterprise.area_spectral_index enable row level security;

create index if not exists idx_area_spectral_index_area on enterprise.area_spectral_index(area_id);
create index if not exists idx_area_spectral_index_mission on enterprise.area_spectral_index(mission_id);

grant select on enterprise.area_spectral_index to authenticated;
grant select, insert, update, delete on enterprise.area_spectral_index to service_role;

drop policy if exists area_spectral_index_select on enterprise.area_spectral_index;
create policy area_spectral_index_select on enterprise.area_spectral_index for select to authenticated
  using (enterprise.is_mission_member(mission_id));

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select count(*) from pg_policies where schemaname='enterprise' and tablename='area_spectral_index';  -- expect 1
--   select has_table_privilege('authenticated', 'enterprise.area_spectral_index', 'select');              -- expect true
--   select has_table_privilege('authenticated', 'enterprise.area_spectral_index', 'insert');               -- expect false

-- ── ROLLBACK (down-path) ────────────────────────────────────────────────────
--   drop policy if exists area_spectral_index_select on enterprise.area_spectral_index;
--   drop table if exists enterprise.area_spectral_index;

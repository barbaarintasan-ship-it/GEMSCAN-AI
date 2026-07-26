-- 0052_geo_tectonic_setting.sql
--
-- Luul Scan — GeoContext P0 (9/N): geo.tectonic_setting — ontology 6/6.
--
-- Tectonic-setting ontology dimension (greenstone belt, rift, craton margin, …) —
-- the bottom of the ontology chain. Node the link tables (0055) and
-- geological_knowledge.tectonic_setting_key (0046) attach to.
--
-- geo.tectonic_setting ONLY — no link tables, no FK backfill (Rule 1). This is the
-- LAST ontology reference table; the FK backfill + link tables + constraints follow
-- in 0053. geo schema, additive; frozen core/public untouched. Idempotent. RLS:
-- readable by authenticated, writes service-only.

create table if not exists geo.tectonic_setting (
  id         uuid primary key default gen_random_uuid(),
  code       text not null,
  name       text not null,
  aliases    text[] not null default '{}',
  metadata   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_tectonic_setting_code on geo.tectonic_setting (code);
create index if not exists idx_tectonic_setting_aliases on geo.tectonic_setting using gin (aliases);

drop trigger if exists trg_set_updated_at on geo.tectonic_setting;
create trigger trg_set_updated_at before update on geo.tectonic_setting
  for each row execute function enterprise.set_updated_at();

alter table geo.tectonic_setting enable row level security;
alter table geo.tectonic_setting force row level security;

grant select on geo.tectonic_setting to authenticated;
grant select, insert, update, delete on geo.tectonic_setting to service_role;

drop policy if exists tectonic_setting_select on geo.tectonic_setting;
create policy tectonic_setting_select on geo.tectonic_setting for select to authenticated
  using (true);

-- ── VERIFY — expect: tbl=1, rls=on, select_pol=1, write_pol=0, uq_code=1 ──
--   select
--     (select count(*) from pg_tables where schemaname='geo' and tablename='tectonic_setting'),
--     (select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='geo' and c.relname='tectonic_setting'),
--     (select count(*) from pg_policies where schemaname='geo' and tablename='tectonic_setting' and cmd='SELECT'),
--     (select count(*) from pg_policies where schemaname='geo' and tablename='tectonic_setting' and cmd in ('INSERT','UPDATE','DELETE','ALL')),
--     (select count(*) from pg_indexes where schemaname='geo' and tablename='tectonic_setting' and indexname='uq_tectonic_setting_code');

-- ── ROLLBACK ──
--   drop policy if exists tectonic_setting_select on geo.tectonic_setting;
--   revoke select, insert, update, delete on geo.tectonic_setting from service_role;
--   revoke select on geo.tectonic_setting from authenticated;
--   drop trigger if exists trg_set_updated_at on geo.tectonic_setting;
--   drop table if exists geo.tectonic_setting;

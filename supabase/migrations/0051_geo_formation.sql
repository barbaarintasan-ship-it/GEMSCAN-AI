-- 0051_geo_formation.sql
--
-- Luul Scan — GeoContext P0 (8/N): geo.formation — ontology 5/6.
--
-- Named-formation ontology dimension (e.g. formations from the UNESCO layer, with
-- geologic age). Node the link tables (0055) and geological_knowledge.formation_key
-- (0046) attach to. `age` carries the geologic age text (e.g. 'Jurassic').
--
-- geo.formation ONLY — no link tables, no FK backfill (Rule 1). geo schema, additive;
-- frozen core/public untouched. Idempotent. RLS: readable by authenticated, writes
-- service-only.

create table if not exists geo.formation (
  id         uuid primary key default gen_random_uuid(),
  code       text not null,
  name       text not null,
  age        text,                                  -- geologic age, e.g. 'Jurassic'
  aliases    text[] not null default '{}',
  metadata   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_formation_code on geo.formation (code);
create index if not exists idx_formation_aliases on geo.formation using gin (aliases);

drop trigger if exists trg_set_updated_at on geo.formation;
create trigger trg_set_updated_at before update on geo.formation
  for each row execute function enterprise.set_updated_at();

alter table geo.formation enable row level security;
alter table geo.formation force row level security;

grant select on geo.formation to authenticated;
grant select, insert, update, delete on geo.formation to service_role;

drop policy if exists formation_select on geo.formation;
create policy formation_select on geo.formation for select to authenticated
  using (true);

-- ── VERIFY — expect: tbl=1, rls=on, select_pol=1, write_pol=0, uq_code=1 ──
--   select
--     (select count(*) from pg_tables where schemaname='geo' and tablename='formation'),
--     (select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='geo' and c.relname='formation'),
--     (select count(*) from pg_policies where schemaname='geo' and tablename='formation' and cmd='SELECT'),
--     (select count(*) from pg_policies where schemaname='geo' and tablename='formation' and cmd in ('INSERT','UPDATE','DELETE','ALL')),
--     (select count(*) from pg_indexes where schemaname='geo' and tablename='formation' and indexname='uq_formation_code');

-- ── ROLLBACK ──
--   drop policy if exists formation_select on geo.formation;
--   revoke select, insert, update, delete on geo.formation from service_role;
--   revoke select on geo.formation from authenticated;
--   drop trigger if exists trg_set_updated_at on geo.formation;
--   drop table if exists geo.formation;

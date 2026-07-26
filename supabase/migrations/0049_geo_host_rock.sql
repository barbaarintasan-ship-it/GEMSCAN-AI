-- 0049_geo_host_rock.sql
--
-- Luul Scan — GeoContext P0 (6/N): geo.host_rock — ontology 3/6.
--
-- Host-rock ontology dimension (quartz vein, ultramafic, pegmatite, …) — the rock
-- body that hosts an occurrence. Node the link tables (0055) and
-- geological_knowledge.host_rock_key (0046) attach to.
--
-- geo.host_rock ONLY — no link tables, no FK backfill (Rule 1). Same pattern as
-- 0047. geo schema, additive; frozen core/public untouched. Idempotent. RLS:
-- readable by authenticated, writes service-only.

create table if not exists geo.host_rock (
  id         uuid primary key default gen_random_uuid(),
  code       text not null,
  name       text not null,
  aliases    text[] not null default '{}',
  metadata   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_host_rock_code on geo.host_rock (code);
create index if not exists idx_host_rock_aliases on geo.host_rock using gin (aliases);

drop trigger if exists trg_set_updated_at on geo.host_rock;
create trigger trg_set_updated_at before update on geo.host_rock
  for each row execute function enterprise.set_updated_at();

alter table geo.host_rock enable row level security;
alter table geo.host_rock force row level security;

grant select on geo.host_rock to authenticated;
grant select, insert, update, delete on geo.host_rock to service_role;

drop policy if exists host_rock_select on geo.host_rock;
create policy host_rock_select on geo.host_rock for select to authenticated
  using (true);

-- ── VERIFY — expect: tbl=1, rls=on, select_pol=1, write_pol=0, uq_code=1 ──
--   select
--     (select count(*) from pg_tables where schemaname='geo' and tablename='host_rock'),
--     (select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='geo' and c.relname='host_rock'),
--     (select count(*) from pg_policies where schemaname='geo' and tablename='host_rock' and cmd='SELECT'),
--     (select count(*) from pg_policies where schemaname='geo' and tablename='host_rock' and cmd in ('INSERT','UPDATE','DELETE','ALL')),
--     (select count(*) from pg_indexes where schemaname='geo' and tablename='host_rock' and indexname='uq_host_rock_code');

-- ── ROLLBACK ──
--   drop policy if exists host_rock_select on geo.host_rock;
--   revoke select, insert, update, delete on geo.host_rock from service_role;
--   revoke select on geo.host_rock from authenticated;
--   drop trigger if exists trg_set_updated_at on geo.host_rock;
--   drop table if exists geo.host_rock;

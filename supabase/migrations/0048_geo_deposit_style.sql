-- 0048_geo_deposit_style.sql
--
-- Luul Scan — GeoContext P0 (5/N): geo.deposit_style — ontology 2/6.
--
-- Deposit-style ontology dimension (orogenic gold, VMS, pegmatite, carbonatite, …).
--
-- ALIGNMENT (per decision): enterprise.deposit_model (0019) is the CANONICAL
-- deposit-type reference (code, name, commodity, typical_hosts). To avoid two
-- ontologies with the same meaning, geo.deposit_style.`code` MUST correspond to an
-- enterprise.deposit_model.`code` — same vocabulary. This table is the thin geo-local
-- ontology NODE the link tables (0055) and geological_knowledge.deposit_style_key
-- (0046) attach to; it does NOT re-list deposit attributes (those stay in
-- deposit_model). A soft validation/link may be added in 0053 (constraints phase).
--
-- geo.deposit_style ONLY — no link tables, no FK backfill (Rule 1). Same pattern as
-- 0047. geo schema, additive; frozen core/public untouched. Idempotent. RLS:
-- readable by authenticated, writes service-only.

create table if not exists geo.deposit_style (
  id         uuid primary key default gen_random_uuid(),
  code       text not null,                        -- aligns with enterprise.deposit_model.code (canonical)
  name       text not null,
  aliases    text[] not null default '{}',
  metadata   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_deposit_style_code on geo.deposit_style (code);
create index if not exists idx_deposit_style_aliases on geo.deposit_style using gin (aliases);

drop trigger if exists trg_set_updated_at on geo.deposit_style;
create trigger trg_set_updated_at before update on geo.deposit_style
  for each row execute function enterprise.set_updated_at();

alter table geo.deposit_style enable row level security;
alter table geo.deposit_style force row level security;

grant select on geo.deposit_style to authenticated;
grant select, insert, update, delete on geo.deposit_style to service_role;

drop policy if exists deposit_style_select on geo.deposit_style;
create policy deposit_style_select on geo.deposit_style for select to authenticated
  using (true);

-- ── VERIFY — expect: tbl=1, rls=on, select_pol=1, write_pol=0, uq_code=1 ──
--   select
--     (select count(*) from pg_tables where schemaname='geo' and tablename='deposit_style'),
--     (select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='geo' and c.relname='deposit_style'),
--     (select count(*) from pg_policies where schemaname='geo' and tablename='deposit_style' and cmd='SELECT'),
--     (select count(*) from pg_policies where schemaname='geo' and tablename='deposit_style' and cmd in ('INSERT','UPDATE','DELETE','ALL')),
--     (select count(*) from pg_indexes where schemaname='geo' and tablename='deposit_style' and indexname='uq_deposit_style_code');

-- ── ROLLBACK ──
--   drop policy if exists deposit_style_select on geo.deposit_style;
--   revoke select, insert, update, delete on geo.deposit_style from service_role;
--   revoke select on geo.deposit_style from authenticated;
--   drop trigger if exists trg_set_updated_at on geo.deposit_style;
--   drop table if exists geo.deposit_style;

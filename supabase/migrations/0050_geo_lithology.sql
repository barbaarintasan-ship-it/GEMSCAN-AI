-- 0050_geo_lithology.sql
--
-- Luul Scan — GeoContext P0 (7/N): geo.lithology — ontology 4/6.
--
-- Lithology ontology dimension (metasediment, granite, basalt, …). Kept as a FLAT
-- reference table (same pattern as the other ontology nodes). Note: enterprise.taxonomy
-- (0019) is a separate, versioned/hierarchical IDENTIFICATION taxonomy framework
-- (mineral/rock ID) — a different concern; this flat lithology dimension is not a
-- duplicate of it. Node the link tables (0055) and geological_knowledge.lithology_key
-- (0046) attach to.
--
-- geo.lithology ONLY — no link tables, no FK backfill (Rule 1). geo schema, additive;
-- frozen core/public untouched. Idempotent. RLS: readable by authenticated, writes
-- service-only.

create table if not exists geo.lithology (
  id         uuid primary key default gen_random_uuid(),
  code       text not null,
  name       text not null,
  rock_class text,                                  -- 'igneous'|'sedimentary'|'metamorphic' (soft)
  aliases    text[] not null default '{}',
  metadata   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_lithology_code on geo.lithology (code);
create index if not exists idx_lithology_class on geo.lithology (rock_class);
create index if not exists idx_lithology_aliases on geo.lithology using gin (aliases);

drop trigger if exists trg_set_updated_at on geo.lithology;
create trigger trg_set_updated_at before update on geo.lithology
  for each row execute function enterprise.set_updated_at();

alter table geo.lithology enable row level security;
alter table geo.lithology force row level security;

grant select on geo.lithology to authenticated;
grant select, insert, update, delete on geo.lithology to service_role;

drop policy if exists lithology_select on geo.lithology;
create policy lithology_select on geo.lithology for select to authenticated
  using (true);

-- ── VERIFY — expect: tbl=1, rls=on, select_pol=1, write_pol=0, uq_code=1 ──
--   select
--     (select count(*) from pg_tables where schemaname='geo' and tablename='lithology'),
--     (select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='geo' and c.relname='lithology'),
--     (select count(*) from pg_policies where schemaname='geo' and tablename='lithology' and cmd='SELECT'),
--     (select count(*) from pg_policies where schemaname='geo' and tablename='lithology' and cmd in ('INSERT','UPDATE','DELETE','ALL')),
--     (select count(*) from pg_indexes where schemaname='geo' and tablename='lithology' and indexname='uq_lithology_code');

-- ── ROLLBACK ──
--   drop policy if exists lithology_select on geo.lithology;
--   revoke select, insert, update, delete on geo.lithology from service_role;
--   revoke select on geo.lithology from authenticated;
--   drop trigger if exists trg_set_updated_at on geo.lithology;
--   drop table if exists geo.lithology;

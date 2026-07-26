-- 0047_geo_commodity.sql
--
-- Luul Scan — GeoContext P0 (4/N): geo.commodity — first ontology reference table.
--
-- Controlled vocabulary of economic commodities (Au, REE, Cr, Ni, Be, …), the top
-- of the geological ontology (Architecture v1.1 §16):
--   Commodity → Deposit Style → Host Rock → Lithology → Formation → Tectonic Setting
--
-- `code` is the stable natural key that geo.geological_knowledge.commodity_key
-- (0046) and geo.mineral_occurrence (0054) will map to; the FK backfill happens in
-- 0053, once ALL reference tables exist. This migration is `geo.commodity` ONLY —
-- NO link tables, NO FK backfill, NO other ontology tables (Rule 1: one table, one
-- purpose). geo schema, additive; frozen core/public untouched. Idempotent.
-- RLS like the other reference tables (0040/0044): readable by authenticated,
-- writes service-role-only.

-- ── Table ──────────────────────────────────────────────────────────────────
create table if not exists geo.commodity (
  id         uuid primary key default gen_random_uuid(),
  code       text not null,                        -- stable natural key, e.g. 'Au','REE','Cr','Ni','Be'
  name       text not null,                        -- 'Gold','Rare Earth Elements','Chromium', …
  symbol     text,                                 -- chemical symbol where applicable ('Au','Ni','Cr','Be')
  category   text,                                 -- 'precious metal'|'base metal'|'gemstone'|'REE'|'industrial'|'energy' (soft)
  aliases    text[] not null default '{}',         -- alternative names/spellings (aids knowledge-extraction matching)
  metadata   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Indexes ────────────────────────────────────────────────────────────────
create unique index if not exists uq_commodity_code on geo.commodity (code);
create index if not exists idx_commodity_category on geo.commodity (category);
create index if not exists idx_commodity_aliases on geo.commodity using gin (aliases);

-- ── updated_at trigger (reuse enterprise.set_updated_at from 0032) ──────────
drop trigger if exists trg_set_updated_at on geo.commodity;
create trigger trg_set_updated_at before update on geo.commodity
  for each row execute function enterprise.set_updated_at();

-- ── RLS: read by authenticated, writes service-only ────────────────────────
alter table geo.commodity enable row level security;
alter table geo.commodity force row level security;

grant select on geo.commodity to authenticated;
grant select, insert, update, delete on geo.commodity to service_role;

drop policy if exists commodity_select on geo.commodity;
create policy commodity_select on geo.commodity for select to authenticated
  using (true);
-- (no write policy → authenticated cannot write; service_role writes via BYPASSRLS)

-- ── VERIFY (CI/CD) — expect: table=1, rls=on, select_pol=1, write_pol=0, uq_code=1 ──
--   select
--     (select count(*) from pg_tables where schemaname='geo' and tablename='commodity') as tbl,
--     (select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='geo' and c.relname='commodity') as rls,
--     (select count(*) from pg_policies where schemaname='geo' and tablename='commodity' and cmd='SELECT') as select_pol,
--     (select count(*) from pg_policies where schemaname='geo' and tablename='commodity' and cmd in ('INSERT','UPDATE','DELETE','ALL')) as write_pol,
--     (select count(*) from pg_indexes where schemaname='geo' and tablename='commodity' and indexname='uq_commodity_code') as uq_code;

-- ── ROLLBACK (down-path) ───────────────────────────────────────────────────
--   drop policy if exists commodity_select on geo.commodity;
--   revoke select, insert, update, delete on geo.commodity from service_role;
--   revoke select on geo.commodity from authenticated;
--   drop trigger if exists trg_set_updated_at on geo.commodity;
--   drop table if exists geo.commodity;

-- 0055_geo_mineral_association.sql
--
-- Luul Scan — GeoContext P0 (12/N): geo.mineral_association.
--
-- The queryable commodity-association knowledge base as an ontology GRAPH edge
-- (Architecture v1.1 §16): a geological CONTEXT (one ontology dimension —
-- host_rock / lithology / deposit_style / tectonic_setting / formation) → a
-- COMMODITY, with a weight. Examples: quartz vein → Au; pegmatite → Be; ultramafic
-- → Cr/Ni; carbonatite → REE.
--
-- One table (Rule 1) with REAL FK integrity instead of a polymorphic column: each
-- context dimension has its own nullable FK, and a CHECK enforces that EXACTLY ONE
-- context is set per edge. This feeds commodityAssociations[] / reasoningFactors[]
-- via joins, not string matching.
--
-- geo schema, additive; frozen core/public untouched. Idempotent. RLS: readable by
-- authenticated, writes service-only.

create table if not exists geo.mineral_association (
  id                  uuid primary key default gen_random_uuid(),
  commodity_id        uuid not null references geo.commodity (id) on delete cascade,
  -- exactly one of these five context dimensions is set (CHECK below):
  host_rock_id        uuid references geo.host_rock (id) on delete cascade,
  lithology_id        uuid references geo.lithology (id) on delete cascade,
  deposit_style_id    uuid references geo.deposit_style (id) on delete cascade,
  tectonic_setting_id uuid references geo.tectonic_setting (id) on delete cascade,
  formation_id        uuid references geo.formation (id) on delete cascade,
  relation            text not null default 'favors',        -- 'favors'|'hosts'|'associated_with' (soft)
  weight              numeric(3,2) check (weight is null or (weight >= 0 and weight <= 1)),
  rationale           text,                                   -- why the association holds
  source              text,                                   -- provenance
  reference           text,
  metadata            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint ck_mineral_association_one_context
    check (num_nonnulls(host_rock_id, lithology_id, deposit_style_id, tectonic_setting_id, formation_id) = 1)
);

-- ── Indexes ────────────────────────────────────────────────────────────────
create index if not exists idx_mineral_assoc_commodity on geo.mineral_association (commodity_id);
create index if not exists idx_mineral_assoc_host_rock on geo.mineral_association (host_rock_id);
create index if not exists idx_mineral_assoc_lithology on geo.mineral_association (lithology_id);
create index if not exists idx_mineral_assoc_deposit_style on geo.mineral_association (deposit_style_id);
create index if not exists idx_mineral_assoc_tectonic on geo.mineral_association (tectonic_setting_id);
create index if not exists idx_mineral_assoc_formation on geo.mineral_association (formation_id);
-- Dedup the same context→commodity edge (NULLS NOT DISTINCT so the null contexts compare equal).
create unique index if not exists uq_mineral_assoc_edge
  on geo.mineral_association (commodity_id, host_rock_id, lithology_id, deposit_style_id, tectonic_setting_id, formation_id, relation)
  nulls not distinct;

-- ── updated_at trigger (reuse enterprise.set_updated_at from 0032) ──────────
drop trigger if exists trg_set_updated_at on geo.mineral_association;
create trigger trg_set_updated_at before update on geo.mineral_association
  for each row execute function enterprise.set_updated_at();

-- ── RLS: read by authenticated, writes service-only ────────────────────────
alter table geo.mineral_association enable row level security;
alter table geo.mineral_association force row level security;

grant select on geo.mineral_association to authenticated;
grant select, insert, update, delete on geo.mineral_association to service_role;

drop policy if exists mineral_association_select on geo.mineral_association;
create policy mineral_association_select on geo.mineral_association for select to authenticated
  using (true);
-- (no write policy → authenticated cannot write; service_role writes via BYPASSRLS)

-- ── VERIFY (CI/CD) — expect: table=1, rls=on, select_pol=1, write_pol=0, fk=6, one_context_check=1 ──
--   select
--     (select count(*) from pg_tables where schemaname='geo' and tablename='mineral_association') as tbl,
--     (select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='geo' and c.relname='mineral_association') as rls,
--     (select count(*) from pg_policies where schemaname='geo' and tablename='mineral_association' and cmd='SELECT') as select_pol,
--     (select count(*) from pg_policies where schemaname='geo' and tablename='mineral_association' and cmd in ('INSERT','UPDATE','DELETE','ALL')) as write_pol,
--     (select count(*) from pg_constraint where conrelid='geo.mineral_association'::regclass and contype='f') as fk,
--     (select count(*) from pg_constraint where conname='ck_mineral_association_one_context') as one_context_check;

-- ── ROLLBACK (down-path) ───────────────────────────────────────────────────
--   drop policy if exists mineral_association_select on geo.mineral_association;
--   revoke select, insert, update, delete on geo.mineral_association from service_role;
--   revoke select on geo.mineral_association from authenticated;
--   drop trigger if exists trg_set_updated_at on geo.mineral_association;
--   drop table if exists geo.mineral_association;

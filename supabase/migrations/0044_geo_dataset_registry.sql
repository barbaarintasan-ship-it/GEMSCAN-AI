-- 0044_geo_dataset_registry.sql
--
-- Luul Scan — GeoContext P0 (1/N): geo.dataset_registry.
--
-- The canonical record of every EXTERNAL geological dataset VERSION that feeds
-- GeoContext (UNESCO geology, USGS MRDS, Greenwood, GEOSOM, UNDP, IAEA, and any
-- future source). All provenance `datasetVersion` references point here, so any
-- refresh of a dataset is diffable and auditable (GeoContext Architecture v1.1
-- §11 / §Data-lineage).
--
-- DATASET INDEPENDENCE (Rule 2): the registry is source-agnostic — a dataset is
-- identified by (source_key, version); category covers spatial vs knowledge;
-- source-specific fields live in `metadata` jsonb. Adding a new dataset (or a new
-- kind of dataset) NEVER requires a schema change.
--
-- Schema change only — one table + its indexes/trigger/RLS (Rule 1). geo schema,
-- additive, does not touch the frozen enterprise core or public. Idempotent.
-- RLS shape follows migration 0040: registry metadata is READABLE by any
-- authenticated user; WRITES are service-role-only (loaded by the versioned
-- ingestion loader script, not by clients).

-- ── Table ──────────────────────────────────────────────────────────────────
create table if not exists geo.dataset_registry (
  id            uuid primary key default gen_random_uuid(),
  source_key    text not null,                              -- stable machine key for the dataset family, e.g. 'usgs_mrds'
  title         text not null,                              -- human-readable name
  category      text,                                       -- 'spatial' | 'knowledge' (soft; kept text for extensibility)
  version       text not null,                              -- dataset version, e.g. '1.0' / '2026.07'
  checksum      text,                                       -- content hash of the imported artifact
  license       text,
  source_url    text,
  crs           text,                                       -- coordinate reference system, e.g. 'EPSG:4326'
  coverage_geom extensions.geometry(Geometry,4326),         -- spatial extent / bbox (null for pure knowledge sources)
  coverage_note text,                                       -- described region when there is no geometry
  record_count  integer check (record_count is null or record_count >= 0),
  released_at   date,                                       -- dataset publication / release date
  ingested_at   timestamptz not null default now(),         -- when this version was loaded
  is_current    boolean not null default true,              -- the active version for this source_key
  metadata      jsonb not null default '{}'::jsonb,         -- source-specific extras (dataset independence)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ── Indexes ────────────────────────────────────────────────────────────────
-- A given (source_key, version) is registered exactly once.
create unique index if not exists uq_dataset_registry_source_version
  on geo.dataset_registry (source_key, version);
-- At most one CURRENT version per dataset family.
create unique index if not exists uq_dataset_registry_current
  on geo.dataset_registry (source_key) where is_current;
create index if not exists idx_dataset_registry_source on geo.dataset_registry (source_key);
create index if not exists idx_dataset_registry_geom on geo.dataset_registry using gist (coverage_geom);

-- ── updated_at trigger (reuse enterprise.set_updated_at from 0032) ──────────
drop trigger if exists trg_set_updated_at on geo.dataset_registry;
create trigger trg_set_updated_at before update on geo.dataset_registry
  for each row execute function enterprise.set_updated_at();

-- ── RLS: read by authenticated, writes service-only ────────────────────────
alter table geo.dataset_registry enable row level security;
alter table geo.dataset_registry force row level security;

grant select on geo.dataset_registry to authenticated;
grant select, insert, update, delete on geo.dataset_registry to service_role;

drop policy if exists dataset_registry_select on geo.dataset_registry;
create policy dataset_registry_select on geo.dataset_registry for select to authenticated
  using (true);
-- (no write policy → authenticated cannot write; service_role writes via BYPASSRLS)

-- ── VERIFY (CI/CD) — expect: table=1, rls=on, select_pol=1, write_pol=0, uniq_idx=2 ──
--   select
--     (select count(*) from pg_tables where schemaname='geo' and tablename='dataset_registry') as tbl,
--     (select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='geo' and c.relname='dataset_registry') as rls,
--     (select count(*) from pg_policies where schemaname='geo' and tablename='dataset_registry' and cmd='SELECT') as select_pol,
--     (select count(*) from pg_policies where schemaname='geo' and tablename='dataset_registry' and cmd in ('INSERT','UPDATE','DELETE','ALL')) as write_pol,
--     (select count(*) from pg_indexes where schemaname='geo' and tablename='dataset_registry' and indexname like 'uq_%') as uniq_idx;

-- ── ROLLBACK (down-path) ───────────────────────────────────────────────────
--   drop policy if exists dataset_registry_select on geo.dataset_registry;
--   revoke select, insert, update, delete on geo.dataset_registry from service_role;
--   revoke select on geo.dataset_registry from authenticated;
--   drop trigger if exists trg_set_updated_at on geo.dataset_registry;
--   drop table if exists geo.dataset_registry;

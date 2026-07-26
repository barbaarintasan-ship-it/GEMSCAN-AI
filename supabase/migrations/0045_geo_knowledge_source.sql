-- 0045_geo_knowledge_source.sql
--
-- Luul Scan — GeoContext P0 (2/N): geo.knowledge_source.
--
-- The document-level catalog of the Geological Knowledge Extraction Pipeline:
-- one row per source DOCUMENT (a Greenwood volume, a UNDP survey report, a GEOSOM
-- report, an IAEA report, a Soviet/Italian/company report, a future publication).
-- geo.geological_knowledge (0046) and geo.mineral_occurrence (0048) reference this
-- for provenance + temporal metadata (Architecture v1.1 §5/§6/§11).
--
-- Lineage chain:  dataset_registry (version)  →  knowledge_source (document)  →
--                 geological_knowledge / mineral_occurrence (facts)
--
-- DATASET INDEPENDENCE (Rule 2): source-agnostic — any report kind is captured via
-- source_type + metadata jsonb, tied to its dataset version by FK; new report
-- sources need NO schema change.
--
-- Schema change only — one table + indexes/trigger/RLS (Rule 1). geo schema,
-- additive, frozen core/public untouched. Idempotent. RLS like 0040/0044:
-- readable by authenticated, writes service-role-only (loader/extraction pipeline).

-- ── Table ──────────────────────────────────────────────────────────────────
create table if not exists geo.knowledge_source (
  id                 uuid primary key default gen_random_uuid(),
  -- Owning dataset VERSION. CASCADE: a document belongs to its dataset version;
  -- a deliberate service-role re-import/rollback of a version removes its docs
  -- (and, via 0046, their extracted facts) as one lineage unit.
  dataset_id         uuid not null references geo.dataset_registry (id) on delete cascade,
  source_type        text,                                    -- 'report'|'publication'|'map'|'survey' (soft; text for extensibility)
  title              text not null,
  authors            text,
  organization       text,                                    -- UN, GEOSOM, IAEA, Soviet, Italian, company, …
  publication_year   integer check (publication_year is null or publication_year between 1800 and 2100),
  exploration_period text,                                    -- e.g. '1968-1973' (temporal)
  language           text,
  uri                text,                                    -- location of the source document
  checksum           text,                                    -- document content hash (dedup)
  page_count         integer check (page_count is null or page_count >= 0),
  reference          text,                                    -- citation
  metadata           jsonb not null default '{}'::jsonb,      -- source-specific extras (dataset independence)
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ── Indexes ────────────────────────────────────────────────────────────────
create index if not exists idx_knowledge_source_dataset on geo.knowledge_source (dataset_id);
create index if not exists idx_knowledge_source_type on geo.knowledge_source (source_type);
-- Dedup identical documents within a dataset version by content hash.
create unique index if not exists uq_knowledge_source_checksum
  on geo.knowledge_source (dataset_id, checksum) where checksum is not null;

-- ── updated_at trigger (reuse enterprise.set_updated_at from 0032) ──────────
drop trigger if exists trg_set_updated_at on geo.knowledge_source;
create trigger trg_set_updated_at before update on geo.knowledge_source
  for each row execute function enterprise.set_updated_at();

-- ── RLS: read by authenticated, writes service-only ────────────────────────
alter table geo.knowledge_source enable row level security;
alter table geo.knowledge_source force row level security;

grant select on geo.knowledge_source to authenticated;
grant select, insert, update, delete on geo.knowledge_source to service_role;

drop policy if exists knowledge_source_select on geo.knowledge_source;
create policy knowledge_source_select on geo.knowledge_source for select to authenticated
  using (true);
-- (no write policy → authenticated cannot write; service_role writes via BYPASSRLS)

-- ── VERIFY (CI/CD) — expect: table=1, rls=on, select_pol=1, write_pol=0, fk=1 ──
--   select
--     (select count(*) from pg_tables where schemaname='geo' and tablename='knowledge_source') as tbl,
--     (select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='geo' and c.relname='knowledge_source') as rls,
--     (select count(*) from pg_policies where schemaname='geo' and tablename='knowledge_source' and cmd='SELECT') as select_pol,
--     (select count(*) from pg_policies where schemaname='geo' and tablename='knowledge_source' and cmd in ('INSERT','UPDATE','DELETE','ALL')) as write_pol,
--     (select count(*) from pg_constraint where conrelid='geo.knowledge_source'::regclass and contype='f') as fk;

-- ── ROLLBACK (down-path) ───────────────────────────────────────────────────
--   drop policy if exists knowledge_source_select on geo.knowledge_source;
--   revoke select, insert, update, delete on geo.knowledge_source from service_role;
--   revoke select on geo.knowledge_source from authenticated;
--   drop trigger if exists trg_set_updated_at on geo.knowledge_source;
--   drop table if exists geo.knowledge_source;

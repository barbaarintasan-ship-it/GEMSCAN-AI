-- 0054_geo_mineral_occurrence.sql
--
-- Luul Scan — GeoContext P0 (11/N): geo.mineral_occurrence.
--
-- The primary EXTERNAL mineral-occurrence layer (Architecture v1.1 §11) — the
-- Category-A "OccurrenceProvider" source: known occurrences from USGS MRDS plus
-- point occurrences extracted from historical reports. Answered by radius/spatial
-- queries at runtime.
--
-- Lineage (data-lineage refinement): every occurrence ties to its dataset version
-- (dataset_id → dataset_registry) and, when extracted from a document, to that
-- document (source_id → knowledge_source), plus extraction_version/parser/ingested_at.
-- Temporal: observation_date / publication_year / exploration_period. Ontology-linked
-- from the start (ontology tables already exist): commodity/deposit_style FK columns
-- alongside raw *_key + a commodities[]/host_rocks[] for multi-valued cases.
--
-- Dataset-independent (Rule 2): source-specific fields in metadata jsonb; external_id
-- keeps the source's own record id. Schema-change-only, one table (Rule 1). geo schema,
-- additive; frozen core/public untouched. Idempotent. RLS: readable by authenticated,
-- writes service-only (loader/extraction pipeline).

create table if not exists geo.mineral_occurrence (
  id                 uuid primary key default gen_random_uuid(),
  -- lineage
  dataset_id         uuid not null references geo.dataset_registry (id) on delete cascade,
  source_id          uuid references geo.knowledge_source (id) on delete set null,
  external_id        text,                                    -- source's own record id (e.g. MRDS dep_id)
  extraction_version text,
  parser             text,
  ingested_at        timestamptz not null default now(),
  -- occurrence
  name               text,
  geom               extensions.geometry(Point,4326),         -- location (GIST-indexed)
  status             text,                                    -- 'occurrence'|'prospect'|'past_producer'|'mine' (soft)
  production         text,
  -- commodity (primary ontology-linked + raw key + multi-valued list)
  commodity_key      text,
  commodity_id       uuid references geo.commodity (id) on delete set null,
  commodities        text[] not null default '{}',
  -- deposit style (ontology-linked + raw)
  deposit_type       text,
  deposit_style_id   uuid references geo.deposit_style (id) on delete set null,
  -- host rocks (raw, multi-valued)
  host_rocks         text[] not null default '{}',
  -- evidence + provenance + temporal
  tier               text,
  confidence         numeric(3,2) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  reference          text,
  observation_date   date,
  publication_year   integer check (publication_year is null or publication_year between 1800 and 2100),
  exploration_period text,
  metadata           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ── Indexes ────────────────────────────────────────────────────────────────
create index if not exists idx_mineral_occurrence_geom on geo.mineral_occurrence using gist (geom);
create index if not exists idx_mineral_occurrence_dataset on geo.mineral_occurrence (dataset_id);
create index if not exists idx_mineral_occurrence_commodity on geo.mineral_occurrence (commodity_id);
create index if not exists idx_mineral_occurrence_commodity_key on geo.mineral_occurrence (commodity_key);
-- Dedup a source's own records within a dataset version.
create unique index if not exists uq_mineral_occurrence_external
  on geo.mineral_occurrence (dataset_id, external_id) where external_id is not null;

-- ── updated_at trigger (reuse enterprise.set_updated_at from 0032) ──────────
drop trigger if exists trg_set_updated_at on geo.mineral_occurrence;
create trigger trg_set_updated_at before update on geo.mineral_occurrence
  for each row execute function enterprise.set_updated_at();

-- ── RLS: read by authenticated, writes service-only ────────────────────────
alter table geo.mineral_occurrence enable row level security;
alter table geo.mineral_occurrence force row level security;

grant select on geo.mineral_occurrence to authenticated;
grant select, insert, update, delete on geo.mineral_occurrence to service_role;

drop policy if exists mineral_occurrence_select on geo.mineral_occurrence;
create policy mineral_occurrence_select on geo.mineral_occurrence for select to authenticated
  using (true);
-- (no write policy → authenticated cannot write; service_role writes via BYPASSRLS)

-- ── VERIFY (CI/CD) — expect: table=1, rls=on, select_pol=1, write_pol=0, fk=4, gist=1 ──
--   select
--     (select count(*) from pg_tables where schemaname='geo' and tablename='mineral_occurrence') as tbl,
--     (select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='geo' and c.relname='mineral_occurrence') as rls,
--     (select count(*) from pg_policies where schemaname='geo' and tablename='mineral_occurrence' and cmd='SELECT') as select_pol,
--     (select count(*) from pg_policies where schemaname='geo' and tablename='mineral_occurrence' and cmd in ('INSERT','UPDATE','DELETE','ALL')) as write_pol,
--     (select count(*) from pg_constraint where conrelid='geo.mineral_occurrence'::regclass and contype='f') as fk,
--     (select count(*) from pg_indexes where schemaname='geo' and tablename='mineral_occurrence' and indexname='idx_mineral_occurrence_geom') as gist;

-- ── ROLLBACK (down-path) ───────────────────────────────────────────────────
--   drop policy if exists mineral_occurrence_select on geo.mineral_occurrence;
--   revoke select, insert, update, delete on geo.mineral_occurrence from service_role;
--   revoke select on geo.mineral_occurrence from authenticated;
--   drop trigger if exists trg_set_updated_at on geo.mineral_occurrence;
--   drop table if exists geo.mineral_occurrence;

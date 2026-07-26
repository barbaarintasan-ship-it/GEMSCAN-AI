-- 0046_geo_geological_knowledge.sql
--
-- Luul Scan — GeoContext P0 (3/N): geo.geological_knowledge.
--
-- The normalized store of ATOMIC geological facts extracted from source documents
-- (Architecture v1.1 §5). One row = ONE fact — never a paragraph or document blob.
-- Fact kinds: occurrence, observation, formation, structural, geochem_anomaly,
-- recommendation, … (kind is soft text so new kinds need no schema change).
--
-- Two design mandates for this migration:
--  1. STABLE FACT MODEL — atomic facts (short normalized `statement`, optional
--     geom + quote/page), so indexing / filtering / confidence weighting / AI
--     reasoning stay simple. Verbatim text goes in `quote`; the fact itself is atomic.
--  2. ONTOLOGY-READY — the ontology tables arrive in 0047, but this table is built
--     for them NOW: each ontology dimension has a nullable *_key TEXT column. 0047
--     will add nullable *_id UUID FK columns and backfill from these keys — a purely
--     additive, backward-compatible change with NO restructuring of existing rows.
--     `attributes` jsonb is for source-specific extras only, NOT the primary store.
--
-- Lineage: dataset_registry → knowledge_source → geological_knowledge (this).
-- Schema change only — one table + indexes/trigger/RLS (Rule 1). geo schema,
-- additive; frozen core/public untouched. Idempotent. RLS like 0044/0045.

-- ── Table ──────────────────────────────────────────────────────────────────
create table if not exists geo.geological_knowledge (
  id                   uuid primary key default gen_random_uuid(),
  -- Owning document. CASCADE: facts belong to their source; re-import/rollback of
  -- a document (or its dataset version, via 0045) removes its facts as one unit.
  source_id            uuid not null references geo.knowledge_source (id) on delete cascade,
  kind                 text not null,                          -- 'occurrence'|'observation'|'formation'|'structural'|'geochem_anomaly'|'recommendation'|… (soft)
  statement            text not null,                          -- the ATOMIC fact, normalized (not a paragraph)
  geom                 extensions.geometry(Geometry,4326),     -- spatial location of the fact, when known
  -- ── ontology-ready keys (0047 adds *_id FK columns + backfills from these) ──
  commodity_key        text,
  deposit_style_key    text,
  host_rock_key        text,
  lithology_key        text,
  formation_key        text,
  tectonic_setting_key text,
  -- ── evidence / confidence ──
  tier                 text,                                   -- evidence tier code (maps to enterprise.evidence_tier)
  confidence           numeric(3,2) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  -- ── provenance / lineage (Architecture §6) ──
  quote                text,                                   -- verbatim supporting text
  page                 integer check (page is null or page >= 0),
  extraction_version   text,                                   -- knowledge-extraction ruleset version, e.g. '2026.07'
  parser               text,                                   -- e.g. 'knowledge-pipeline-v1'
  ingested_at          timestamptz not null default now(),
  -- ── temporal (fact-level; report-level lives on knowledge_source) ──
  observation_date     date,
  attributes           jsonb not null default '{}'::jsonb,     -- source-specific extras only
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- ── Indexes ────────────────────────────────────────────────────────────────
create index if not exists idx_geo_knowledge_source on geo.geological_knowledge (source_id);
create index if not exists idx_geo_knowledge_kind on geo.geological_knowledge (kind);
create index if not exists idx_geo_knowledge_commodity on geo.geological_knowledge (commodity_key);
create index if not exists idx_geo_knowledge_geom on geo.geological_knowledge using gist (geom);

-- ── updated_at trigger (reuse enterprise.set_updated_at from 0032) ──────────
drop trigger if exists trg_set_updated_at on geo.geological_knowledge;
create trigger trg_set_updated_at before update on geo.geological_knowledge
  for each row execute function enterprise.set_updated_at();

-- ── RLS: read by authenticated, writes service-only ────────────────────────
alter table geo.geological_knowledge enable row level security;
alter table geo.geological_knowledge force row level security;

grant select on geo.geological_knowledge to authenticated;
grant select, insert, update, delete on geo.geological_knowledge to service_role;

drop policy if exists geo_knowledge_select on geo.geological_knowledge;
create policy geo_knowledge_select on geo.geological_knowledge for select to authenticated
  using (true);
-- (no write policy → authenticated cannot write; service_role writes via BYPASSRLS)

-- ── VERIFY (CI/CD) — expect: table=1, rls=on, select_pol=1, write_pol=0, fk=1, ontology_keys=6 ──
--   select
--     (select count(*) from pg_tables where schemaname='geo' and tablename='geological_knowledge') as tbl,
--     (select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='geo' and c.relname='geological_knowledge') as rls,
--     (select count(*) from pg_policies where schemaname='geo' and tablename='geological_knowledge' and cmd='SELECT') as select_pol,
--     (select count(*) from pg_policies where schemaname='geo' and tablename='geological_knowledge' and cmd in ('INSERT','UPDATE','DELETE','ALL')) as write_pol,
--     (select count(*) from pg_constraint where conrelid='geo.geological_knowledge'::regclass and contype='f') as fk,
--     (select count(*) from information_schema.columns where table_schema='geo' and table_name='geological_knowledge' and column_name like '%\_key') as ontology_keys;

-- ── ROLLBACK (down-path) ───────────────────────────────────────────────────
--   drop policy if exists geo_knowledge_select on geo.geological_knowledge;
--   revoke select, insert, update, delete on geo.geological_knowledge from service_role;
--   revoke select on geo.geological_knowledge from authenticated;
--   drop trigger if exists trg_set_updated_at on geo.geological_knowledge;
--   drop table if exists geo.geological_knowledge;

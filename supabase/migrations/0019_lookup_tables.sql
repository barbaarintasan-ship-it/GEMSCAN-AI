-- 0019_lookup_tables.sql
--
-- Luul Scan Enterprise — Phase 1, Sprint 2 (1/14): controlled vocabularies,
-- registries and config. These are INDEPENDENT lookups: they hold no foreign
-- keys into enterprise entities (only internal self/among-lookup references),
-- so they can be created right after the 0018 foundation.
--
-- Additive & isolated: creates tables only in `enterprise` and `geo`. It does
-- NOT touch `public` (consumer), NOT create RLS/functions, and changes nothing
-- from 0018 or 0001-0017.
--
-- Idempotent: every object uses IF NOT EXISTS. Re-running is a no-op.
-- Rollback (down-path) is documented at the bottom and is a clean table drop.
--
-- Depends on: 0018 (schemas enterprise/geo, extensions postgis+pgcrypto,
--             enum enterprise.evidence_type). gen_random_uuid() is core (PG13+).

-- ── Geological taxonomy (A3.1.1) ───────────────────────────────────────────
create table if not exists enterprise.taxonomy (
  id                  uuid primary key default gen_random_uuid(),
  domain              text not null,               -- rock|lithology|mineral|alteration|structure|deposit_model
  name                text not null,
  current_version_id  uuid,                         -- soft ref to taxonomy_version (FK added later to avoid a cycle)
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists enterprise.taxonomy_version (
  id           uuid primary key default gen_random_uuid(),
  taxonomy_id  uuid not null references enterprise.taxonomy(id) on delete cascade,
  version      text not null,
  source       text,                                -- IUGS | GeoSciML | internal | ...
  published_at timestamptz,
  constraint uq_taxonomy_version unique (taxonomy_id, version)
);
create index if not exists idx_taxonomy_version_taxonomy on enterprise.taxonomy_version(taxonomy_id);

create table if not exists enterprise.taxonomy_node (
  id           uuid primary key default gen_random_uuid(),
  taxonomy_id  uuid not null references enterprise.taxonomy(id) on delete cascade,
  parent_id    uuid references enterprise.taxonomy_node(id) on delete set null,
  code         text not null,
  label        text not null,
  level        smallint,
  path         text,                                -- materialized "igneous.volcanic.basalt"
  attributes   jsonb,
  constraint uq_taxonomy_node_code unique (taxonomy_id, code)
);
create index if not exists idx_taxonomy_node_parent on enterprise.taxonomy_node(taxonomy_id, parent_id);
create index if not exists idx_taxonomy_node_code on enterprise.taxonomy_node(code);
create index if not exists idx_taxonomy_node_path on enterprise.taxonomy_node(path);

create table if not exists enterprise.taxonomy_alias (
  id       uuid primary key default gen_random_uuid(),
  node_id  uuid not null references enterprise.taxonomy_node(id) on delete cascade,
  alias    text not null,
  source   text,                                    -- 'common' | 'GeoSciML:...' | 'USGS:...' | 'JORC:...'
  constraint uq_taxonomy_alias unique (node_id, alias, source)
);
create index if not exists idx_taxonomy_alias_node on enterprise.taxonomy_alias(node_id);

-- ── Geologic time scale (A3.1.2) ───────────────────────────────────────────
create table if not exists enterprise.geologic_time (
  id         uuid primary key default gen_random_uuid(),
  rank       text not null,                         -- eon|era|period|epoch|age
  name       text not null,
  parent_id  uuid references enterprise.geologic_time(id) on delete set null,
  start_ma   numeric(8,3),
  end_ma     numeric(8,3),
  constraint uq_geologic_time unique (rank, name)
);
create index if not exists idx_geologic_time_parent on enterprise.geologic_time(parent_id);
create index if not exists idx_geologic_time_rank on enterprise.geologic_time(rank);

-- ── Deposit-model library (A3.1.3) ─────────────────────────────────────────
create table if not exists enterprise.deposit_model (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,               -- orogenic_gold|epithermal|iocg|vms|porphyry|pegmatite|laterite|ree
  name          text not null,
  commodity     text,
  description   text,
  typical_hosts uuid[],                              -- taxonomy_node ids (array, no FK)
  attributes    jsonb,
  created_at    timestamptz not null default now()
);

-- ── Evidence tier (A1.3 / A2.3.2) ──────────────────────────────────────────
create table if not exists enterprise.evidence_tier (
  evidence_type      enterprise.evidence_type primary key,
  tier               text not null,                 -- highest|medium|lower
  weight             numeric(5,2) not null,
  ai_label_eligible  boolean not null default false -- only 'highest' = true
);

-- ── Configuration family (A3.1.6) ──────────────────────────────────────────
-- Surrogate id PK + a unique index over (namespace,key,org) with a zero-uuid
-- sentinel for the global (null-org) default, because a nullable column cannot
-- sit in a primary key. organization_id is a SOFT reference here; its FK to
-- enterprise.organization is added in a later migration (organization is 0020).
create table if not exists enterprise.config_entry (
  id              uuid primary key default gen_random_uuid(),
  namespace       text not null,                    -- score_weights|verification_rules|trust_rules|thresholds|ai_parameters|mission_parameters
  key             text not null,
  value           jsonb not null,
  description     text,
  organization_id uuid,                              -- null = global default
  updated_by      uuid,
  updated_at      timestamptz not null default now()
);
create unique index if not exists uq_config_entry
  on enterprise.config_entry (namespace, key, coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ── Feature flags (A3.1.8) ─────────────────────────────────────────────────
create table if not exists enterprise.feature_flag (
  key             text primary key,
  description     text,
  default_enabled boolean not null default false,
  is_beta         boolean not null default false
);

-- ── Sensor type (A3.2.3 hook) ──────────────────────────────────────────────
create table if not exists enterprise.sensor_type (
  id       uuid primary key default gen_random_uuid(),
  code     text not null unique,                    -- drone|thermal|spectrometer|xrf|lidar
  name     text not null,
  modality text
);

-- ── Spatial raster layer registry (A3.2.2 hook — metadata only) ────────────
create table if not exists geo.raster_layer_registry (
  id            uuid primary key default gen_random_uuid(),
  kind          text,                                -- terrain|magnetic|gravity|satellite
  source        text,                                -- SRTM|Sentinel|Landsat|ASTER|DEM
  name          text,
  extent        extensions.geography(Polygon,4326),
  resolution_m  numeric,
  crs           text,
  storage_ref   text,                                -- where tiles will live (Phase 4)
  status        text,                                -- registered|ingesting|available
  attributes    jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists idx_raster_registry_extent on geo.raster_layer_registry using gist (extent);
create index if not exists idx_raster_registry_kind on geo.raster_layer_registry(kind);

-- ── ROLLBACK (down-path) — clean table drop; never touches `public` ────────
--   drop table if exists geo.raster_layer_registry;
--   drop table if exists enterprise.sensor_type;
--   drop table if exists enterprise.feature_flag;
--   drop table if exists enterprise.config_entry;
--   drop table if exists enterprise.evidence_tier;
--   drop table if exists enterprise.deposit_model;
--   drop table if exists enterprise.geologic_time;
--   drop table if exists enterprise.taxonomy_alias;
--   drop table if exists enterprise.taxonomy_node;
--   drop table if exists enterprise.taxonomy_version;
--   drop table if exists enterprise.taxonomy;

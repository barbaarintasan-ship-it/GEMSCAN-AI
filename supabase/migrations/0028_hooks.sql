-- 0028_hooks.sql
--
-- Luul Scan Enterprise — Phase 1, Sprint 2 (10/14): forward-looking HOOKS
-- (interfaces/registries only — NO processing logic) plus the async job queue.
-- These let Phase 2+ features (coverage, knowledge graph, sensors, offline
-- conflict resolution, background workers) attach later WITHOUT reshaping the
-- schema.
--
-- Additive & isolated (enterprise + geo). Idempotent. Depends on: 0018, 0019
-- (sensor_type), 0020 (organization, auth), 0021 (exploration_area), 0023
-- (sample). No new dependencies, no heavy queries, no consumer changes.

-- ── Coverage grid (A2.3.6 — materialized H3 aggregate) ─────────────────────
create table if not exists geo.coverage_cell (
  area_id         uuid not null references enterprise.exploration_area(id) on delete cascade,
  h3              text not null,
  resolution      smallint not null,
  sample_count    integer not null default 0,
  verified_count  integer not null default 0,
  last_sampled_at timestamptz,
  density_band    text,                                    -- none|low|medium|high
  geom            extensions.geometry(Polygon,4326),
  primary key (area_id, h3)
);
create index if not exists idx_coverage_cell_area on geo.coverage_cell(area_id);
create index if not exists idx_coverage_cell_h3 on geo.coverage_cell(h3);
create index if not exists idx_coverage_cell_geom on geo.coverage_cell using gist (geom);

-- ── Knowledge-graph edges (A3.2.1 hook) ────────────────────────────────────
create table if not exists enterprise.geo_relationship (
  id           uuid primary key default gen_random_uuid(),
  subject_type text,
  subject_id   uuid,
  predicate    text not null,                             -- occurs_in|hosted_by|inside|near|altered_to
  object_type  text,
  object_id    uuid,
  weight       numeric,
  source       text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_geo_rel_subject on enterprise.geo_relationship(subject_type, subject_id);
create index if not exists idx_geo_rel_object on enterprise.geo_relationship(object_type, object_id);
create index if not exists idx_geo_rel_predicate on enterprise.geo_relationship(predicate);

-- ── Sensor abstraction (A3.2.3 hook — interfaces only) ─────────────────────
create table if not exists enterprise.sensor (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid references enterprise.organization(id) on delete set null,
  sensor_type_id  uuid references enterprise.sensor_type(id) on delete set null,
  model           text,
  serial          text,
  calibration     jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists idx_sensor_org on enterprise.sensor(organization_id);

create table if not exists enterprise.sensor_capture (
  id          uuid primary key default gen_random_uuid(),
  sensor_id   uuid references enterprise.sensor(id) on delete cascade,
  sample_id   uuid references enterprise.sample(id) on delete set null,
  area_id     uuid references enterprise.exploration_area(id) on delete set null,
  captured_at timestamptz,
  location    extensions.geography(Point,4326),
  metadata    jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists idx_sensor_capture_sensor on enterprise.sensor_capture(sensor_id);
create index if not exists idx_sensor_capture_location on enterprise.sensor_capture using gist (location);

create table if not exists enterprise.sensor_file (
  id         uuid primary key default gen_random_uuid(),
  capture_id uuid references enterprise.sensor_capture(id) on delete cascade,
  storage_path text,
  format     text,
  size_bytes bigint,
  created_at timestamptz not null default now()
);
create index if not exists idx_sensor_file_capture on enterprise.sensor_file(capture_id);

-- ── Offline conflict log (A3.2.4 hook — engine is Sprint 6) ────────────────
create table if not exists enterprise.conflict_log (
  id           uuid primary key default gen_random_uuid(),
  entity_type  text,
  entity_id    uuid,
  device_a     text,
  device_b     text,
  base_version jsonb,
  version_a    jsonb,
  version_b    jsonb,
  strategy     text,                                      -- last_write_wins|field_merge|manual
  resolution   jsonb,
  resolved_by  uuid references auth.users(id) on delete set null,
  resolved_at  timestamptz,
  status       text not null default 'open',              -- open|resolved
  created_at   timestamptz not null default now()
);
create index if not exists idx_conflict_log_entity on enterprise.conflict_log(entity_type, entity_id);
create index if not exists idx_conflict_log_status on enterprise.conflict_log(status);

-- ── Processing job queue (async workers — interface only, no worker logic) ─
create table if not exists enterprise.processing_job (
  id          uuid primary key default gen_random_uuid(),
  job_type    text not null,                              -- coverage_recompute|confidence_recompute|raster_import|ai_preprocess|feature_extract
  status      text not null default 'queued',             -- queued|running|done|failed
  payload     jsonb,
  started_at  timestamptz,
  finished_at timestamptz,
  error       text,
  retry_count integer not null default 0,
  created_at  timestamptz not null default now(),
  constraint ck_processing_job_retry check (retry_count >= 0)
);
create index if not exists idx_processing_job_type on enterprise.processing_job(job_type);
create index if not exists idx_processing_job_status on enterprise.processing_job(status);

-- ── VERIFY (CI/CD) — expect: ent_tables=6, geo_tables=1(coverage), gist=2 ──
--   select
--     (select count(*) from information_schema.tables where table_schema='enterprise'
--        and table_name in ('geo_relationship','sensor','sensor_capture','sensor_file','conflict_log','processing_job')) as ent_tables,
--     (select count(*) from information_schema.tables where table_schema='geo' and table_name='coverage_cell') as coverage,
--     (select count(*) from pg_indexes where indexdef like '%gist%'
--        and (indexname='idx_coverage_cell_geom' or indexname='idx_sensor_capture_location')) as gist;

-- ── ROLLBACK (down-path) — clean drop; never touches `public`/auth ─────────
--   drop table if exists enterprise.processing_job;
--   drop table if exists enterprise.conflict_log;
--   drop table if exists enterprise.sensor_file;
--   drop table if exists enterprise.sensor_capture;
--   drop table if exists enterprise.sensor;
--   drop table if exists enterprise.geo_relationship;
--   drop table if exists geo.coverage_cell;

-- 0023_samples.sql
--
-- Luul Scan Enterprise — Phase 1, Sprint 2 (5/14): the atomic field-evidence
-- unit — sample + its location, media, and device context.
--
-- Additive & isolated (enterprise only). Idempotent. Depends on: 0018 (enums),
-- 0020 (auth.users), 0021 (exploration_area, geo.geological_layer), 0022
-- (exploration_mission).
--
-- PARTITIONING NOTE (decision "Option A", amends A2.6): `sample` uses a simple
-- PK(id) here so the ~13 child tables keep clean single-column `sample_id` FKs
-- and full referential integrity. Time-partitioning by collected_at is DEFERRED
-- to a dedicated pre-production migration performed while the table is still
-- empty/small (painless recreate) — not partitioned on a large live table.
-- `id` is client-suppliable to support offline idempotent upsert.

-- ── Sample (atomic evidence unit) ──────────────────────────────────────────
create table if not exists enterprise.sample (
  id                       uuid primary key default gen_random_uuid(),
  area_id                  uuid not null references enterprise.exploration_area(id) on delete cascade,
  mission_id               uuid references enterprise.exploration_mission(id) on delete set null,
  collector_id             uuid references auth.users(id) on delete set null,
  collected_at             timestamptz not null,
  host_context             text,
  rock_condition           text,                                   -- A1.1
  in_situ                  boolean,                                -- in-situ vs transported
  geological_environment   text,
  terrain_type             enterprise.terrain_type,
  weather_conditions       text,
  field_observations       text,
  sample_method            enterprise.sample_method,               -- A3.1.4
  formation_id             uuid references geo.geological_layer(id) on delete set null,  -- A3.1.4 lithology link
  status                   enterprise.sample_status not null default 'submitted',
  completeness_status      enterprise.completeness not null default 'incomplete',
  gps_accuracy_score       numeric(5,2),
  image_quality_score      numeric(5,2),
  field_reliability_score  numeric(5,2),                           -- A1.2 device trust
  confidence_score         numeric(5,2) not null default 0,
  created_by               uuid references auth.users(id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  deleted_at               timestamptz,
  constraint ck_sample_gps_score   check (gps_accuracy_score      is null or (gps_accuracy_score      >= 0 and gps_accuracy_score      <= 100)),
  constraint ck_sample_img_score   check (image_quality_score     is null or (image_quality_score     >= 0 and image_quality_score     <= 100)),
  constraint ck_sample_field_score check (field_reliability_score is null or (field_reliability_score >= 0 and field_reliability_score <= 100)),
  constraint ck_sample_confidence  check (confidence_score >= 0 and confidence_score <= 100)
);
create index if not exists idx_sample_area on enterprise.sample(area_id);
create index if not exists idx_sample_mission on enterprise.sample(mission_id);
create index if not exists idx_sample_collector on enterprise.sample(collector_id);
create index if not exists idx_sample_status on enterprise.sample(status);
create index if not exists idx_sample_collected_at on enterprise.sample(collected_at);

-- ── Sample location (1:1) ──────────────────────────────────────────────────
create table if not exists enterprise.sample_location (
  sample_id      uuid primary key references enterprise.sample(id) on delete cascade,
  location       extensions.geography(Point,4326) not null,
  altitude_m     double precision,
  gps_accuracy_m double precision,
  h3_cell        text not null,
  provenance     enterprise.gps_source not null,
  constraint ck_sample_location_accuracy check (gps_accuracy_m is null or gps_accuracy_m >= 0)
);
create index if not exists idx_sample_location_geo on enterprise.sample_location using gist (location);
create index if not exists idx_sample_location_h3 on enterprise.sample_location(h3_cell);

-- ── Sample media (roles; A1.1.7) ───────────────────────────────────────────
create table if not exists enterprise.sample_media (
  id                  uuid primary key default gen_random_uuid(),
  sample_id           uuid not null references enterprise.sample(id) on delete cascade,
  role                enterprise.media_role not null,
  is_required         boolean not null default true,
  storage_path        text not null,
  thumb_path          text,
  image_quality_score numeric(5,2),
  retake_requested    boolean not null default false,
  width               integer,
  height              integer,
  exif                jsonb,
  created_at          timestamptz not null default now(),
  constraint ck_sample_media_score check (image_quality_score is null or (image_quality_score >= 0 and image_quality_score <= 100))
);
-- one media per role, except 'extra' which may repeat
create unique index if not exists uq_sample_media_role on enterprise.sample_media (sample_id, role) where role <> 'extra';
create index if not exists idx_sample_media_sample on enterprise.sample_media(sample_id);

-- ── Sample device context (1:1; A1.2.2) ────────────────────────────────────
create table if not exists enterprise.sample_device_context (
  sample_id         uuid primary key references enterprise.sample(id) on delete cascade,
  device_id         text,
  app_version       text,
  os                text,
  gps_source        enterprise.gps_source,
  capture_timestamp timestamptz,
  mock_location     boolean not null default false,
  offline_capture   boolean not null default false,
  sync_timestamp    timestamptz
);
create index if not exists idx_sample_device_device on enterprise.sample_device_context(device_id);

-- ── VERIFY (CI/CD) — expect: tables=4, gist=1, checks(sample)=4, fks(->sample)=3 ──
--   select
--     (select count(*) from information_schema.tables where table_schema='enterprise'
--        and table_name in ('sample','sample_location','sample_media','sample_device_context')) as tables,
--     (select count(*) from pg_indexes where schemaname='enterprise' and indexdef like '%gist%'
--        and tablename='sample_location') as gist,
--     (select count(*) from pg_constraint c join pg_class t on c.conrelid=t.oid
--        where c.contype='c' and t.relname='sample') as sample_checks,
--     (select count(*) from pg_constraint c join pg_class t on c.conrelid=t.oid join pg_class r on c.confrelid=r.oid
--        where c.contype='f' and r.relname='sample' and t.relnamespace='enterprise'::regnamespace) as fks_to_sample;

-- ── ROLLBACK (down-path) — clean drop; never touches `public`/auth ─────────
--   drop table if exists enterprise.sample_device_context;
--   drop table if exists enterprise.sample_media;
--   drop table if exists enterprise.sample_location;
--   drop table if exists enterprise.sample;

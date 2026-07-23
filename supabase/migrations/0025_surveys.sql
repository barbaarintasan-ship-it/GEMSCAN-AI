-- 0025_surveys.sql
--
-- Luul Scan Enterprise — Phase 1, Sprint 2 (7/14): survey effort + absence data
-- (A2.2.4). Captures "where a contributor looked" (survey_track) and per-point
-- findings including NEGATIVE observations (no_mineralization) — essential to
-- de-bias future AI (presence-only data is biased).
--
-- Additive & isolated (enterprise). Idempotent. Depends on: 0018 (enum
-- finding_type, postgis), 0021 (exploration_area), 0022 (exploration_mission),
-- 0023 (sample). IDs are client-suppliable for offline idempotent upsert.

-- ── Survey track (coverage of effort) ──────────────────────────────────────
create table if not exists enterprise.survey_track (
  id             uuid primary key default gen_random_uuid(),
  area_id        uuid not null references enterprise.exploration_area(id) on delete cascade,
  mission_id     uuid references enterprise.exploration_mission(id) on delete set null,
  contributor_id uuid references auth.users(id) on delete set null,
  path           extensions.geography(LineString,4326),
  started_at     timestamptz,
  ended_at       timestamptz,
  h3_cells       text[],
  created_at     timestamptz not null default now()
);
create index if not exists idx_survey_track_path on enterprise.survey_track using gist (path);
create index if not exists idx_survey_track_area on enterprise.survey_track(area_id);
create index if not exists idx_survey_track_contributor on enterprise.survey_track(contributor_id);

-- ── Field observation point (positive AND negative findings) ───────────────
create table if not exists enterprise.field_observation_point (
  id              uuid primary key default gen_random_uuid(),
  area_id         uuid not null references enterprise.exploration_area(id) on delete cascade,
  survey_track_id uuid references enterprise.survey_track(id) on delete set null,
  contributor_id  uuid references auth.users(id) on delete set null,
  location        extensions.geography(Point,4326) not null,
  h3_cell         text not null,
  finding         enterprise.finding_type not null,          -- includes no_mineralization (absence)
  sample_id       uuid references enterprise.sample(id) on delete set null,   -- set when finding=sample_collected
  notes           text,
  created_at      timestamptz not null default now()
);
create index if not exists idx_fop_location on enterprise.field_observation_point using gist (location);
create index if not exists idx_fop_area on enterprise.field_observation_point(area_id);
create index if not exists idx_fop_h3 on enterprise.field_observation_point(h3_cell);
create index if not exists idx_fop_finding on enterprise.field_observation_point(finding);

-- ── VERIFY (CI/CD) — expect: tables=2, gist=2 ──────────────────────────────
--   select
--     (select count(*) from information_schema.tables where table_schema='enterprise'
--        and table_name in ('survey_track','field_observation_point')) as tables,
--     (select count(*) from pg_indexes where schemaname='enterprise' and indexdef like '%gist%'
--        and tablename in ('survey_track','field_observation_point')) as gist;

-- ── ROLLBACK (down-path) — clean drop; never touches `public`/auth ─────────
--   drop table if exists enterprise.field_observation_point;
--   drop table if exists enterprise.survey_track;

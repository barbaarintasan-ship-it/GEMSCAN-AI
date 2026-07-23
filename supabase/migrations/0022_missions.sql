-- 0022_missions.sql
--
-- Luul Scan Enterprise — Phase 1, Sprint 2 (4/14): exploration missions —
-- campaigns, their areas/roster, per-cell assignments, and derived progress.
--
-- Additive & isolated (enterprise only). Idempotent (IF NOT EXISTS). Depends
-- on: 0018 (enums mission_status/assignment_status/contributor_role), 0020
-- (project, auth.users), 0021 (exploration_area for mission_area).
-- FK on-delete policy as in 0020 (owner/creator SET NULL; junctions CASCADE).

-- ── Mission (goal-driven collection campaign) ──────────────────────────────
create table if not exists enterprise.exploration_mission (
  id                        uuid primary key default gen_random_uuid(),
  name                      text not null,
  description               text,
  owner_id                  uuid references auth.users(id) on delete set null,
  project_id                uuid references enterprise.project(id) on delete cascade,
  target_observation_count  integer not null default 0,
  target_coverage_pct       numeric(5,2) not null default 0,
  starts_at                 timestamptz,
  ends_at                   timestamptz,
  status                    enterprise.mission_status not null default 'planned',
  created_by                uuid references auth.users(id) on delete set null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  deleted_at                timestamptz,
  constraint ck_mission_target_count check (target_observation_count >= 0),
  constraint ck_mission_target_cov check (target_coverage_pct >= 0 and target_coverage_pct <= 100)
);
create index if not exists idx_mission_status on enterprise.exploration_mission(status);
create index if not exists idx_mission_project on enterprise.exploration_mission(project_id);

-- ── Mission ↔ area (M:N) ───────────────────────────────────────────────────
create table if not exists enterprise.mission_area (
  mission_id uuid not null references enterprise.exploration_mission(id) on delete cascade,
  area_id    uuid not null references enterprise.exploration_area(id) on delete cascade,
  primary key (mission_id, area_id)
);
create index if not exists idx_mission_area_area on enterprise.mission_area(area_id);

-- ── Mission roster ─────────────────────────────────────────────────────────
create table if not exists enterprise.mission_contributor (
  mission_id     uuid not null references enterprise.exploration_mission(id) on delete cascade,
  contributor_id uuid not null references auth.users(id) on delete cascade,
  role           enterprise.contributor_role not null,
  added_at       timestamptz not null default now(),
  primary key (mission_id, contributor_id)
);
create index if not exists idx_mission_contributor_user on enterprise.mission_contributor(contributor_id);

-- ── Per-cell assignments (drives coverage) ─────────────────────────────────
create table if not exists enterprise.mission_assignment (
  id             uuid primary key default gen_random_uuid(),
  mission_id     uuid not null references enterprise.exploration_mission(id) on delete cascade,
  contributor_id uuid references auth.users(id) on delete set null,
  target_h3      text,
  due_at         timestamptz,
  status         enterprise.assignment_status not null default 'assigned',
  created_at     timestamptz not null default now()
);
create index if not exists idx_mission_assignment_mission on enterprise.mission_assignment(mission_id);
create index if not exists idx_mission_assignment_contributor on enterprise.mission_assignment(contributor_id);
create index if not exists idx_mission_assignment_status on enterprise.mission_assignment(status);

-- ── Derived progress (1:1 mission; maintained by Edge Fn / cron) ───────────
create table if not exists enterprise.mission_progress (
  mission_id        uuid primary key references enterprise.exploration_mission(id) on delete cascade,
  observation_count integer not null default 0,
  sample_count      integer not null default 0,
  coverage_pct      numeric(5,2) not null default 0,
  updated_at        timestamptz not null default now(),
  constraint ck_mission_progress_cov check (coverage_pct >= 0 and coverage_pct <= 100)
);

-- ── VERIFY (CI/CD) — expect: tables=5, indexes>=6, fks(->auth)=3, checks=3 ──
--   select
--     (select count(*) from information_schema.tables where table_schema='enterprise'
--        and table_name in ('exploration_mission','mission_area','mission_contributor','mission_assignment','mission_progress')) as tables,
--     (select count(*) from pg_indexes where schemaname='enterprise'
--        and tablename in ('exploration_mission','mission_area','mission_contributor','mission_assignment','mission_progress')) as indexes,
--     (select count(*) from pg_constraint c join pg_class t on c.conrelid=t.oid
--        where c.contype='c' and t.relname in ('exploration_mission','mission_progress')) as checks;

-- ── ROLLBACK (down-path) — clean table drop; never touches `public`/auth ───
--   drop table if exists enterprise.mission_progress;
--   drop table if exists enterprise.mission_assignment;
--   drop table if exists enterprise.mission_contributor;
--   drop table if exists enterprise.mission_area;
--   drop table if exists enterprise.exploration_mission;

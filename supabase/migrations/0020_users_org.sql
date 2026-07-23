-- 0020_users_org.sql
--
-- Luul Scan Enterprise — Phase 1, Sprint 2 (2/14): identity, organizations
-- (tenancy) and the field-contributor profile.
--
-- Additive & isolated: creates tables only in `enterprise`. It references the
-- existing `auth.users` (Supabase Auth) as the single identity root — the same
-- pattern the consumer schema uses — but does NOT modify auth or `public`.
--
-- FK on-delete policy (implementation choice, data-preserving; entities and
-- relationships are exactly as designed in A2):
--   * ownership/creator refs (owner_id, created_by) -> auth.users ON DELETE SET
--     NULL, columns nullable, so enterprise data survives account deletion.
--   * membership/junction refs -> ON DELETE CASCADE (meaningless without the user).
--
-- Idempotent (IF NOT EXISTS); documented rollback. Depends on: 0018 (enums
-- org_role, contributor_role, project_visibility; schema enterprise).

-- ── Organization (tenant root) ─────────────────────────────────────────────
create table if not exists enterprise.organization (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text unique,
  plan        text,
  status      text not null default 'active',
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

-- ── Organization membership (tenant isolation predicate source) ────────────
create table if not exists enterprise.organization_member (
  organization_id uuid not null references enterprise.organization(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  role            enterprise.org_role not null default 'member',
  added_at        timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index if not exists idx_org_member_user on enterprise.organization_member(user_id);

-- ── Field contributor profile (RBAC + reputation) ──────────────────────────
create table if not exists enterprise.field_contributor (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  role              enterprise.contributor_role not null default 'normal',
  training_level    smallint not null default 0,
  home_region       text,
  reputation_score  numeric(6,2) not null default 50.00,
  status            text not null default 'active',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint uq_field_contributor_user unique (user_id),
  constraint ck_field_contributor_reputation check (reputation_score >= 0 and reputation_score <= 100)
);
create index if not exists idx_field_contributor_role on enterprise.field_contributor(role);
create index if not exists idx_field_contributor_reputation on enterprise.field_contributor(reputation_score);

-- ── Project (tenancy + visibility grouping) ────────────────────────────────
create table if not exists enterprise.project (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  owner_id        uuid references auth.users(id) on delete set null,
  organization_id uuid references enterprise.organization(id) on delete cascade,
  visibility      enterprise.project_visibility not null default 'private',
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);
create index if not exists idx_project_org on enterprise.project(organization_id);
create index if not exists idx_project_owner on enterprise.project(owner_id);

-- ── ROLLBACK (down-path) — clean table drop; never touches `public`/auth ───
--   drop table if exists enterprise.project;
--   drop table if exists enterprise.field_contributor;
--   drop table if exists enterprise.organization_member;
--   drop table if exists enterprise.organization;

-- 0021_geography.sql
--
-- Luul Scan Enterprise — Phase 1, Sprint 2 (3/14): the spatial core —
-- exploration areas (seed + user-created), their memberships, and curated
-- geological layers.
--
-- Additive & isolated: tables in `enterprise` and `geo`. Uses PostGIS
-- geography/geometry (schema-qualified `extensions.*`) with GIST indexes. Does
-- NOT touch `public`/auth.
--
-- Idempotent (IF NOT EXISTS); documented rollback. Depends on: 0018 (schemas,
-- postgis, enums area_origin/area_status/terrain_type/verification_state/
-- contributor_role), 0020 (project, auth.users).
--
-- FK on-delete policy as in 0020 (creator refs SET NULL; membership CASCADE).

-- ── Curated geological layers (geo) ────────────────────────────────────────
create table if not exists geo.geological_layer (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  kind        text not null,                                   -- formation|fault|lithology|greenstone_belt|...
  geom        extensions.geometry(Geometry,4326) not null,     -- mixed geometry (polygon/line)
  source      text,
  attributes  jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists idx_geological_layer_geom on geo.geological_layer using gist (geom);
create index if not exists idx_geological_layer_kind on geo.geological_layer(kind);

-- ── Exploration area (seed + user-created) ─────────────────────────────────
create table if not exists enterprise.exploration_area (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  region              text,
  district            text,
  description         text,
  terrain_type        enterprise.terrain_type,
  geological_notes    text,
  origin              enterprise.area_origin not null default 'user',
  creator_id          uuid references auth.users(id) on delete set null,
  project_id          uuid references enterprise.project(id) on delete cascade,   -- null = community/public
  center              extensions.geography(Point,4326) not null,
  boundary            extensions.geography(MultiPolygon,4326),                    -- A2: MultiPolygon (disjoint OK)
  altitude_m          double precision,
  gps_accuracy_m      double precision,
  h3_center           text,
  status              enterprise.area_status not null default 'new',
  confidence_score    numeric(5,2) not null default 0,
  verification_status enterprise.verification_state not null default 'unverified',
  created_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  constraint ck_exploration_area_confidence check (confidence_score >= 0 and confidence_score <= 100),
  constraint ck_exploration_area_accuracy check (gps_accuracy_m is null or gps_accuracy_m >= 0)
);
create index if not exists idx_exploration_area_center on enterprise.exploration_area using gist (center);
create index if not exists idx_exploration_area_boundary on enterprise.exploration_area using gist (boundary);
create index if not exists idx_exploration_area_status on enterprise.exploration_area(status);
create index if not exists idx_exploration_area_project on enterprise.exploration_area(project_id);
create index if not exists idx_exploration_area_h3 on enterprise.exploration_area(h3_center);

-- ── Area membership (who may contribute to a private area) ─────────────────
create table if not exists enterprise.area_membership (
  area_id   uuid not null references enterprise.exploration_area(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  role      enterprise.contributor_role not null,
  added_at  timestamptz not null default now(),
  primary key (area_id, user_id)
);
create index if not exists idx_area_membership_user on enterprise.area_membership(user_id);

-- ── ROLLBACK (down-path) — clean table drop; never touches `public`/auth ───
--   drop table if exists enterprise.area_membership;
--   drop table if exists enterprise.exploration_area;
--   drop table if exists geo.geological_layer;

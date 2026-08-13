-- 0095_expedition.sql
--
-- Exploration Platform v2, Slice 2 — the EXPEDITION: the server-side identity of
-- one walk.
--
-- WHY THIS EXISTS
-- ---------------
-- `enterprise.exploration_mission` is a PLAN: targets, roster, coverage, status
-- 'planned'. An expedition is one campaign actually walked. They have different
-- lifetimes — a mission may span many expeditions, and most solo expeditions
-- have no mission at all — so conflating them would mean either inventing plans
-- nobody made or losing the record of what was actually done.
--
-- Until now nothing recorded the walk at all. The mobile app mints an
-- `explorationSessionId`, scopes the track to it, keeps the waypoints in device
-- storage, and discards all of it when the screen closes. A day of ground
-- covered and the platform learned nothing (Architecture v2 §0.2: nothing
-- collected in the field is ever discarded).
--
-- `device_session_id` IS the idempotency key. An expedition may be walked on
-- Monday, uploaded on Friday over a weak link, and retried twice on the way —
-- and must still be one row. Every write path below upserts on it.
--
-- Additive & isolated: new tables in `enterprise`, plus nullable FKs on existing
-- tables. Nothing existing changes shape, so every current read keeps working
-- and no backfill is required — a sample with no expedition is a valid
-- historical record, not a broken one.
--
-- Idempotent (IF NOT EXISTS / OR REPLACE); documented rollback. Depends on:
-- 0018 (schemas, postgis, enums), 0020 (project, auth.users), 0021
-- (exploration_area), 0022 (exploration_mission), 0023 (sample).

-- ── Enums ──────────────────────────────────────────────────────────────────
do $$ begin create type enterprise.expedition_status as enum ('active','closed','recovered');
exception when duplicate_object then null; end $$;

-- What a field observation IS. Mirrors the mobile waypoint catalogue
-- (lib/field/waypointTypes.ts) one-for-one, so an observation already on a
-- device maps across without loss, and extends it with the site kinds
-- Architecture v2 §4.3 needs. Values are stable ids; display copy is in i18n.
do $$ begin create type enterprise.field_object_type as enum (
  'outcrop','float','quartz-vein','vein','sulfides','gossan','alteration',
  'fault','contact','pegmatite','shear','spring','old_workings','mine_entrance',
  'trench','other'
);
exception when duplicate_object then null; end $$;

-- ── Expedition ─────────────────────────────────────────────────────────────
create table if not exists enterprise.expedition (
  id                 uuid primary key default gen_random_uuid(),
  -- The mobile session id. UNIQUE per creator: two geologists' devices may
  -- theoretically mint the same short id, and neither should overwrite the other.
  device_session_id  text not null,
  project_id         uuid references enterprise.project(id) on delete cascade,
  mission_id         uuid references enterprise.exploration_mission(id) on delete set null,
  area_id            uuid references enterprise.exploration_area(id) on delete set null,
  name               text,
  status             enterprise.expedition_status not null default 'active',
  started_at         timestamptz not null,
  ended_at           timestamptz,
  -- From the device's own accumulated track stats, never recomputed from the
  -- uploaded line: thinning a stored traverse must not shrink the walk someone
  -- actually made.
  distance_m         double precision not null default 0,
  moving_ms          bigint not null default 0,
  observation_count  integer not null default 0,
  sample_count       integer not null default 0,
  closed_by          text,
  created_by         uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  constraint uq_expedition_session unique (created_by, device_session_id),
  constraint ck_expedition_span check (ended_at is null or ended_at >= started_at),
  constraint ck_expedition_distance check (distance_m >= 0)
);
create index if not exists idx_expedition_creator on enterprise.expedition(created_by);
create index if not exists idx_expedition_status on enterprise.expedition(status);
create index if not exists idx_expedition_started on enterprise.expedition(started_at desc);
create index if not exists idx_expedition_project on enterprise.expedition(project_id);

-- ── Field observation (Layer 2, real geometry) ─────────────────────────────
-- Point today; the geometry column is deliberately generic so Slice 3 can store
-- a vein as a LineString and an alteration zone as a Polygon without a
-- migration that rewrites rows. Same approach geo.geological_layer already takes.
create table if not exists enterprise.field_observation (
  id              uuid primary key default gen_random_uuid(),
  -- The device's own id for this record: the idempotency key for the upload.
  local_id        text not null,
  expedition_id   uuid not null references enterprise.expedition(id) on delete cascade,
  area_id         uuid references enterprise.exploration_area(id) on delete set null,
  sample_id       uuid references enterprise.sample(id) on delete set null,
  contributor_id  uuid references auth.users(id) on delete set null,
  object_type     enterprise.field_object_type not null,
  geom            extensions.geometry(Geometry,4326),
  h3_cell         text,
  name            text,
  notes           text,
  -- As the receiver reported it. NOT rounded: a reviewer needs to know whether
  -- this pin is worth a metre or fifty.
  gps_accuracy_m  double precision,
  altitude_m      double precision,
  fix_age_ms      integer,
  provisional     boolean not null default false,
  heading_deg     numeric(5,2),
  photo_count     integer not null default 0,
  captured_at     timestamptz not null,
  observed_update timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  constraint uq_field_observation_local unique (expedition_id, local_id),
  constraint ck_field_obs_accuracy check (gps_accuracy_m is null or gps_accuracy_m >= 0)
);
create index if not exists idx_field_obs_expedition on enterprise.field_observation(expedition_id);
create index if not exists idx_field_obs_geom on enterprise.field_observation using gist (geom);
create index if not exists idx_field_obs_type on enterprise.field_observation(object_type);
create index if not exists idx_field_obs_h3 on enterprise.field_observation(h3_cell);

-- ── The traverse ───────────────────────────────────────────────────────────
-- One row per expedition, replaced as the walk grows. enterprise.survey_track
-- (0025) already models a track but requires an area_id, and an area is not
-- derived until Slice 5 — this carries the line from the first walk onward and
-- Slice 5 attaches it to the area it produced.
create table if not exists enterprise.expedition_track (
  expedition_id uuid primary key references enterprise.expedition(id) on delete cascade,
  path          extensions.geography(LineString,4326),
  point_count   integer not null default 0,
  distance_m    double precision not null default 0,
  moving_ms     bigint not null default 0,
  updated_at    timestamptz not null default now()
);
create index if not exists idx_expedition_track_path on enterprise.expedition_track using gist (path);

-- ── Parent links on existing records (nullable; no backfill) ───────────────
alter table enterprise.sample
  add column if not exists expedition_id uuid references enterprise.expedition(id) on delete set null;
create index if not exists idx_sample_expedition on enterprise.sample(expedition_id);

alter table enterprise.survey_track
  add column if not exists expedition_id uuid references enterprise.expedition(id) on delete set null;

-- ── RLS ────────────────────────────────────────────────────────────────────
-- The simplest correct rule for Slice 2: a geologist sees and writes their own
-- expeditions. Project/organisation sharing arrives with the area work (Slice 5)
-- and will extend these policies rather than replace them — the same shape
-- 0036_area_policies uses for community versus private areas.
alter table enterprise.expedition        enable row level security;
alter table enterprise.field_observation enable row level security;
alter table enterprise.expedition_track  enable row level security;

drop policy if exists p_expedition_own on enterprise.expedition;
create policy p_expedition_own on enterprise.expedition
  for all to authenticated
  using (created_by = auth.uid())
  with check (created_by = auth.uid());

drop policy if exists p_field_obs_own on enterprise.field_observation;
create policy p_field_obs_own on enterprise.field_observation
  for all to authenticated
  using (exists (select 1 from enterprise.expedition e
                 where e.id = expedition_id and e.created_by = auth.uid()))
  with check (exists (select 1 from enterprise.expedition e
                      where e.id = expedition_id and e.created_by = auth.uid()));

drop policy if exists p_expedition_track_own on enterprise.expedition_track;
create policy p_expedition_track_own on enterprise.expedition_track
  for all to authenticated
  using (exists (select 1 from enterprise.expedition e
                 where e.id = expedition_id and e.created_by = auth.uid()))
  with check (exists (select 1 from enterprise.expedition e
                      where e.id = expedition_id and e.created_by = auth.uid()));

grant usage on schema enterprise to authenticated;
grant select, insert, update on enterprise.expedition        to authenticated;
grant select, insert, update on enterprise.field_observation to authenticated;
grant select, insert, update on enterprise.expedition_track  to authenticated;

-- ── Write paths ────────────────────────────────────────────────────────────
-- All three upsert on the device's own id, because the device may retry any of
-- them after an unknown outcome. That is the normal case on a field link, not
-- the exception.

create or replace function enterprise.open_expedition(
  p_actor uuid, p_session text, p_started timestamptz, p_project uuid default null
) returns uuid
language plpgsql
security definer
set search_path = enterprise, extensions, public
as $$
declare v_id uuid;
begin
  insert into enterprise.expedition (device_session_id, started_at, project_id, created_by)
  values (p_session, p_started, p_project, p_actor)
  on conflict (created_by, device_session_id) do update
    set updated_at = now()
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function enterprise.close_expedition(
  p_actor uuid, p_session text, p_ended timestamptz,
  p_distance_m double precision, p_moving_ms bigint,
  p_observation_count integer, p_closed_by text
) returns uuid
language plpgsql
security definer
set search_path = enterprise, extensions, public
as $$
declare v_id uuid;
begin
  update enterprise.expedition
     set status = case when p_closed_by = 'recovered' then 'recovered'::enterprise.expedition_status
                       else 'closed'::enterprise.expedition_status end,
         ended_at = p_ended,
         -- The device's accumulated numbers win: it was there.
         distance_m = greatest(distance_m, p_distance_m),
         moving_ms = greatest(moving_ms, p_moving_ms),
         observation_count = greatest(observation_count, p_observation_count),
         closed_by = p_closed_by,
         updated_at = now()
   where created_by = p_actor and device_session_id = p_session
  returning id into v_id;

  if v_id is null then
    raise exception 'expedition % not found for actor', p_session using errcode = 'no_data_found';
  end if;
  return v_id;
end;
$$;

create or replace function enterprise.upsert_field_observation(
  p_actor uuid, p_session text, p_obs jsonb
) returns uuid
language plpgsql
security definer
set search_path = enterprise, extensions, public
as $$
declare
  v_exp uuid;
  v_id  uuid;
  v_lat double precision := nullif(p_obs->>'lat','')::double precision;
  v_lng double precision := nullif(p_obs->>'lng','')::double precision;
begin
  select id into v_exp from enterprise.expedition
   where created_by = p_actor and device_session_id = p_session;
  if v_exp is null then
    raise exception 'expedition % not found for actor', p_session using errcode = 'no_data_found';
  end if;

  insert into enterprise.field_observation (
    local_id, expedition_id, contributor_id, object_type, geom,
    name, notes, gps_accuracy_m, altitude_m, fix_age_ms, provisional,
    heading_deg, photo_count, captured_at, observed_update, deleted_at
  ) values (
    p_obs->>'local_id', v_exp, p_actor,
    (p_obs->>'object_type')::enterprise.field_object_type,
    case when v_lat is null or v_lng is null then null
         else extensions.ST_SetSRID(extensions.ST_MakePoint(v_lng, v_lat), 4326) end,
    nullif(p_obs->>'name',''), nullif(p_obs->>'notes',''),
    nullif(p_obs->>'gps_accuracy_m','')::double precision,
    nullif(p_obs->>'altitude_m','')::double precision,
    nullif(p_obs->>'fix_age_ms','')::integer,
    coalesce((p_obs->>'provisional')::boolean, false),
    nullif(p_obs->>'heading_deg','')::numeric,
    coalesce((p_obs->>'photo_count')::integer, 0),
    (p_obs->>'captured_at')::timestamptz,
    nullif(p_obs->>'updated_at','')::timestamptz,
    nullif(p_obs->>'deleted_at','')::timestamptz
  )
  on conflict (expedition_id, local_id) do update set
    object_type    = excluded.object_type,
    geom           = excluded.geom,
    name           = excluded.name,
    notes          = excluded.notes,
    gps_accuracy_m = excluded.gps_accuracy_m,
    altitude_m     = excluded.altitude_m,
    fix_age_ms     = excluded.fix_age_ms,
    provisional    = excluded.provisional,
    heading_deg    = excluded.heading_deg,
    photo_count    = excluded.photo_count,
    observed_update = excluded.observed_update,
    deleted_at     = excluded.deleted_at,
    updated_at     = now()
  returning id into v_id;

  update enterprise.expedition e
     set observation_count = (
           select count(*) from enterprise.field_observation o
            where o.expedition_id = v_exp and o.deleted_at is null),
         updated_at = now()
   where e.id = v_exp;

  return v_id;
end;
$$;

create or replace function enterprise.upsert_expedition_track(
  p_actor uuid, p_session text, p_points jsonb,
  p_distance_m double precision, p_moving_ms bigint
) returns uuid
language plpgsql
security definer
set search_path = enterprise, extensions, public
as $$
declare
  v_exp  uuid;
  v_line extensions.geography(LineString,4326);
  v_n    integer;
begin
  select id into v_exp from enterprise.expedition
   where created_by = p_actor and device_session_id = p_session;
  if v_exp is null then
    raise exception 'expedition % not found for actor', p_session using errcode = 'no_data_found';
  end if;

  select count(*) into v_n from jsonb_array_elements(p_points);
  -- Two points make a line. One does not, and ST_MakeLine would accept it.
  if v_n < 2 then
    raise exception 'a track needs at least two points' using errcode = 'invalid_parameter_value';
  end if;

  select extensions.ST_MakeLine(
           array_agg(extensions.ST_SetSRID(
             extensions.ST_MakePoint((p->>0)::double precision, (p->>1)::double precision), 4326)
             order by ord)
         )::extensions.geography
    into v_line
    from jsonb_array_elements(p_points) with ordinality as t(p, ord);

  insert into enterprise.expedition_track (
    expedition_id, path, point_count, distance_m, moving_ms, updated_at
  ) values (v_exp, v_line, v_n, p_distance_m, p_moving_ms, now())
  on conflict (expedition_id) do update set
    path        = excluded.path,
    point_count = excluded.point_count,
    distance_m  = greatest(enterprise.expedition_track.distance_m, excluded.distance_m),
    moving_ms   = greatest(enterprise.expedition_track.moving_ms, excluded.moving_ms),
    updated_at  = now();

  return v_exp;
end;
$$;

revoke all on function enterprise.open_expedition(uuid, text, timestamptz, uuid) from public;
revoke all on function enterprise.close_expedition(uuid, text, timestamptz, double precision, bigint, integer, text) from public;
revoke all on function enterprise.upsert_field_observation(uuid, text, jsonb) from public;
revoke all on function enterprise.upsert_expedition_track(uuid, text, jsonb, double precision, bigint) from public;

-- ── VERIFY (CI/CD) — expect tables=3, functions=4, policies=3 ─────────────
--   select
--     (select count(*) from information_schema.tables where table_schema='enterprise'
--        and table_name in ('expedition','field_observation','expedition_track')) as tables,
--     (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--        where n.nspname='enterprise' and p.proname in
--        ('open_expedition','close_expedition','upsert_field_observation','upsert_expedition_track')) as functions,
--     (select count(*) from pg_policies where schemaname='enterprise'
--        and tablename in ('expedition','field_observation','expedition_track')) as policies;

-- ── ROLLBACK (down-path) ──────────────────────────────────────────────────
--   drop function if exists enterprise.upsert_expedition_track(uuid, text, jsonb, double precision, bigint);
--   drop function if exists enterprise.upsert_field_observation(uuid, text, jsonb);
--   drop function if exists enterprise.close_expedition(uuid, text, timestamptz, double precision, bigint, integer, text);
--   drop function if exists enterprise.open_expedition(uuid, text, timestamptz, uuid);
--   alter table enterprise.survey_track drop column if exists expedition_id;
--   alter table enterprise.sample drop column if exists expedition_id;
--   drop table if exists enterprise.expedition_track;
--   drop table if exists enterprise.field_observation;
--   drop table if exists enterprise.expedition;
--   drop type if exists enterprise.field_object_type;
--   drop type if exists enterprise.expedition_status;

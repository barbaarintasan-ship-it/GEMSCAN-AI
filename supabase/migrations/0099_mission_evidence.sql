-- Field missions, their evidence, and the assessments made of them.
--
-- THE SPLIT, and why
--
-- Postgres holds metadata and relationships. Cloudflare R2 holds the bytes.
-- Photographs are the bulk of a field mission and they are immutable once taken,
-- so keeping them in object storage — reached by a key recorded here — keeps the
-- database small, keeps egress off the Postgres bill, and means a photo can be
-- served by a presigned URL without a row ever being read.
--
-- No BYTEA columns, no base64, and no public URLs. Field evidence carries
-- coordinates of mineral occurrences; every read is a presigned GET that expires.
--
-- ONE MISSION, ONE PACKAGE, keyed on the device's own id. Every write here is an
-- upsert on that id, so a retry after a timeout cannot produce a second mission —
-- the phone is on a cellular link in a wadi and timeouts are the normal case.

create schema if not exists geo;

-- ── The mission ─────────────────────────────────────────────────────────────
create table if not exists geo.field_mission (
  -- The device's own mission id. Not a server sequence: it is generated offline,
  -- referenced by the package and by every photo, and must survive the trip.
  id              text primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  session_id      text,

  -- What was investigated. The cell IS the target; the centre is carried so a
  -- reader needs no H3 library to put it on a map.
  target_cell     text not null,
  target_lat      double precision not null,
  target_lng      double precision not null,

  -- The best point inside the area, when the evidence named one. Null is the
  -- ordinary answer and a real one: most areas score evenly and no point was
  -- invented for them.
  hotspot_lat     double precision,
  hotspot_lng     double precision,
  hotspot_lift    double precision,

  commodity       text,
  -- The engine's score for the target when the mission was taken. Kept as it was
  -- then, never recomputed: it is what the geologist was told.
  prospectivity   double precision,

  state           text not null default 'section_completed',
  started_at      timestamptz,
  arrived_at      timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint field_mission_state_known check (state in (
    'section_completed', 'waiting_for_upload', 'ready_for_ai',
    'ai_analysis_complete', 'mission_closed', 'failed'
  ))
);

create index if not exists field_mission_user_idx on geo.field_mission (user_id, created_at desc);
create index if not exists field_mission_cell_idx on geo.field_mission (target_cell);

-- ── Who owns a mission id ───────────────────────────────────────────────────
-- Claimed at the FIRST presign, before any bytes move.
--
-- The key shape is missions/{missionId}/photos/{photoId}.jpg, and a mission id is
-- generated on the device as ms-{base36 time}-{seq} — which is guessable. Without
-- this table an authenticated user could ask for an upload URL inside somebody
-- else's mission prefix and overwrite their evidence. The claim is first-come and
-- permanent: after it, only the claimant can be signed into that prefix.
create table if not exists geo.mission_claim (
  mission_id  text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  claimed_at  timestamptz not null default now()
);

create index if not exists mission_claim_user_idx on geo.mission_claim (user_id);

alter table geo.mission_claim enable row level security;

-- Claim a mission id, or confirm the caller already holds it.
--
-- Returns false when somebody else owns it. The caller must refuse to sign
-- anything on a false — that is the whole purpose of the function.
create or replace function geo.claim_mission(p_actor uuid, p_mission text)
returns boolean
language plpgsql
security definer
set search_path = geo, public
as $$
declare v_owner uuid;
begin
  if p_mission is null or length(p_mission) = 0 then
    return false;
  end if;
  insert into geo.mission_claim (mission_id, user_id)
  values (p_mission, p_actor)
  on conflict (mission_id) do nothing;

  select user_id into v_owner from geo.mission_claim where mission_id = p_mission;
  return v_owner = p_actor;
end;
$$;

revoke all on function geo.claim_mission(uuid, text) from public;
grant execute on function geo.claim_mission(uuid, text) to service_role;

-- ── The evidence package ────────────────────────────────────────────────────
-- The whole package as the device assembled it, stored verbatim. The columns
-- above are for querying; this is the record, and an assessment months later must
-- be readable against exactly what was submitted, not against a reconstruction.
create table if not exists geo.mission_package (
  id              text primary key,
  mission_id      text not null references geo.field_mission(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  version         integer not null,
  payload         jsonb not null,
  observation_count integer not null default 0,
  photo_count     integer not null default 0,
  track_points    integer not null default 0,
  -- Set only once every photograph named in the payload has been confirmed
  -- present in R2. Analysis does not start before then.
  files_verified_at timestamptz,
  received_at     timestamptz not null default now()
);

create index if not exists mission_package_mission_idx on geo.mission_package (mission_id);

-- ── Photographs ─────────────────────────────────────────────────────────────
create table if not exists geo.evidence_photo (
  -- The device's photo id, so an upload retry cannot create a second row.
  id              text primary key,
  mission_id      text not null references geo.field_mission(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,

  -- Where the bytes are. NOT a URL: URLs expire, keys do not, and a stored URL
  -- would be a dead link the day the signing key rotates.
  r2_key          text not null unique,
  content_type    text not null default 'image/jpeg',
  bytes           bigint,

  -- Where and when it was taken. Nullable because the sky is not always
  -- available, and an observation with no fix is still a real observation.
  lat             double precision,
  lng             double precision,
  gps_accuracy_m  double precision,
  heading_deg     double precision,
  -- Derived on the device and carried, so nothing downstream re-judges it.
  position_quality text,
  captured_at     timestamptz,

  uploaded_at     timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists evidence_photo_mission_idx on geo.evidence_photo (mission_id);

-- ── The assessment ──────────────────────────────────────────────────────────
-- Note what this table CANNOT hold: there is no probability column and no
-- "confirmed" column. The schema makes "70% chance of gold" unrepresentable
-- rather than relying on a prompt to discourage it.
create table if not exists geo.mission_report (
  id              uuid primary key default gen_random_uuid(),
  mission_id      text not null references geo.field_mission(id) on delete cascade,
  package_id      text not null references geo.mission_package(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,

  interpretation  text not null,
  evidence_summary text not null,
  supporting_factors text[] not null default '{}',
  -- The honest half of an assessment: what was never looked at.
  missing_evidence text[] not null default '{}',
  recommended_next_steps text[] not null default '{}',

  -- Qualitative, from the vocabulary the app uses everywhere else.
  prospectivity_assessment text,
  evidence_strength text,
  confidence      text,
  uncertainty     text,

  model           text,
  created_at      timestamptz not null default now()
);

create index if not exists mission_report_mission_idx on geo.mission_report (mission_id, created_at desc);

-- ── RLS: a geologist sees their own field work, and nobody else's ───────────
alter table geo.field_mission   enable row level security;
alter table geo.mission_package enable row level security;
alter table geo.evidence_photo  enable row level security;
alter table geo.mission_report  enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'geo' and tablename = 'field_mission' and policyname = 'own missions') then
    create policy "own missions" on geo.field_mission for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'geo' and tablename = 'mission_package' and policyname = 'own packages') then
    create policy "own packages" on geo.mission_package for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'geo' and tablename = 'evidence_photo' and policyname = 'own photos') then
    create policy "own photos" on geo.evidence_photo for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'geo' and tablename = 'mission_report' and policyname = 'own reports') then
    create policy "own reports" on geo.mission_report for select using (auth.uid() = user_id);
  end if;
end $$;

-- Writes go through SECURITY DEFINER RPCs with the actor passed explicitly,
-- matching the expedition sync path. No client writes directly.

-- ── Intake ──────────────────────────────────────────────────────────────────
-- One call, one transaction: the mission, the package and every photo row land
-- together or not at all. A package whose photos half-registered would be
-- analysed against an evidence set nobody could reproduce.
create or replace function geo.upsert_mission_package(
  p_actor uuid,
  p_package jsonb
) returns text
language plpgsql
security definer
set search_path = geo, public
as $$
declare
  v_mission_id text := p_package->>'missionId';
  v_package_id text := p_package->>'id';
  v_photo jsonb;
  v_obs jsonb;
  v_photos integer := 0;
begin
  -- Named up front. Without this a package missing targetCell fails later on a
  -- not-null constraint, and the device sees an opaque Postgres error instead of
  -- being told which field it did not send.
  if v_mission_id is null or v_package_id is null then
    raise exception 'package must carry missionId and id';
  end if;
  if p_package->>'targetCell' is null then
    raise exception 'package % has no targetCell', v_package_id;
  end if;
  if p_package->'targetCentre'->>'lat' is null
     or p_package->'targetCentre'->>'lng' is null then
    raise exception 'package % has no targetCentre', v_package_id;
  end if;

  insert into geo.field_mission (
    id, user_id, session_id, target_cell, target_lat, target_lng,
    hotspot_lat, hotspot_lng, hotspot_lift, commodity, prospectivity,
    state, started_at, arrived_at, completed_at, updated_at
  ) values (
    v_mission_id,
    p_actor,
    p_package->>'explorationSessionId',
    p_package->>'targetCell',
    (p_package->'targetCentre'->>'lat')::double precision,
    (p_package->'targetCentre'->>'lng')::double precision,
    (p_package->'hotspot'->>'lat')::double precision,
    (p_package->'hotspot'->>'lng')::double precision,
    (p_package->'hotspot'->>'liftOverCentre')::double precision,
    p_package->>'commodity',
    (p_package->>'prospectivityScore')::double precision,
    'section_completed',
    to_timestamp((p_package->>'createdAt')::bigint / 1000.0),
    case when p_package->>'arrivedAt' is null then null
         else to_timestamp((p_package->>'arrivedAt')::bigint / 1000.0) end,
    to_timestamp((p_package->>'completedAt')::bigint / 1000.0),
    now()
  )
  on conflict (id) do update set
    state = 'section_completed',
    commodity = excluded.commodity,
    updated_at = now();

  -- Photo rows come from the package, one per photograph named in it. The bytes
  -- are uploaded separately and directly to R2; `uploaded_at` is set by the
  -- verification pass, never here.
  for v_obs in select * from jsonb_array_elements(coalesce(p_package->'observations', '[]'::jsonb))
  loop
    for v_photo in select * from jsonb_array_elements(coalesce(v_obs->'photos', '[]'::jsonb))
    loop
      insert into geo.evidence_photo (
        id, mission_id, user_id, r2_key, lat, lng,
        gps_accuracy_m, heading_deg, position_quality, captured_at
      ) values (
        v_photo->>'id',
        v_mission_id,
        p_actor,
        'missions/' || v_mission_id || '/photos/' || (v_photo->>'id') || '.jpg',
        (v_obs->'position'->>'lat')::double precision,
        (v_obs->'position'->>'lng')::double precision,
        (v_obs->'position'->>'accuracyM')::double precision,
        (v_obs->>'headingDeg')::double precision,
        v_obs->>'positionQuality',
        to_timestamp((v_photo->>'capturedAt')::bigint / 1000.0)
      )
      on conflict (id) do nothing;
      v_photos := v_photos + 1;
    end loop;
  end loop;

  insert into geo.mission_package (
    id, mission_id, user_id, version, payload,
    observation_count, photo_count, track_points
  ) values (
    v_package_id, v_mission_id, p_actor,
    coalesce((p_package->>'version')::integer, 1),
    p_package,
    jsonb_array_length(coalesce(p_package->'observations', '[]'::jsonb)),
    v_photos,
    jsonb_array_length(coalesce(p_package->'track', '[]'::jsonb))
  )
  on conflict (id) do update set
    payload = excluded.payload,
    observation_count = excluded.observation_count,
    photo_count = excluded.photo_count,
    track_points = excluded.track_points,
    received_at = now();

  return v_package_id;
end;
$$;

revoke all on function geo.upsert_mission_package(uuid, jsonb) from public;
grant execute on function geo.upsert_mission_package(uuid, jsonb) to service_role;

-- ── Verification ────────────────────────────────────────────────────────────
-- Called only after each object has actually been seen in R2. An upload is not
-- "successful" because a device said so; it is successful because the bytes are
-- there and something on the server looked.
create or replace function geo.mark_photos_verified(
  p_actor uuid,
  p_mission text,
  p_verified jsonb
) returns integer
language plpgsql
security definer
set search_path = geo, public
as $$
declare
  v_row jsonb;
  v_count integer := 0;
  v_missing integer;
begin
  for v_row in select * from jsonb_array_elements(coalesce(p_verified, '[]'::jsonb))
  loop
    update geo.evidence_photo
       set uploaded_at = now(),
           bytes = coalesce((v_row->>'bytes')::bigint, bytes)
     where id = v_row->>'id'
       and mission_id = p_mission
       and user_id = p_actor;
    if found then v_count := v_count + 1; end if;
  end loop;

  -- The package becomes analysable only when NOTHING is still unverified. A
  -- partial set would be assessed as though it were the whole record.
  select count(*) into v_missing
    from geo.evidence_photo
   where mission_id = p_mission and uploaded_at is null;

  if v_missing = 0 then
    update geo.mission_package
       set files_verified_at = now()
     where mission_id = p_mission and files_verified_at is null;
    update geo.field_mission
       set state = 'ready_for_ai', updated_at = now()
     where id = p_mission and state in ('section_completed', 'waiting_for_upload');
  end if;

  return v_count;
end;
$$;

revoke all on function geo.mark_photos_verified(uuid, text, jsonb) from public;
grant execute on function geo.mark_photos_verified(uuid, text, jsonb) to service_role;

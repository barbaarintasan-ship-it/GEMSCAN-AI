-- 0103_evidence_photo_caption.sql
--
-- A photograph gets to say what it shows.
--
-- WHY
-- ---
-- The field report has a Visual Evidence section, and it had nowhere to draw from.
-- `geo.evidence_photo` recorded WHERE a photograph is (`r2_key`), where it was
-- taken and how good the fix was — and nothing at all about what is in it.
--
-- Two different statements are needed, and they must never be confused:
--
--   caption         the GEOLOGIST's own words. "White quartz vein, iron stained
--                   on the fracture face." Evidence, written by the person who
--                   was standing there.
--   ai_description  what the model read from the image. An interpretation of a
--                   photograph, and clearly labelled as one wherever it is shown.
--
-- Kept as separate columns rather than one "description" so nothing downstream
-- can present the second as the first. A geologist's note and a model's reading
-- carry different weight, and a report that blurs them is a report that quietly
-- promotes a guess to an observation.
--
-- Both nullable: most photographs will have neither, and a photograph with no
-- caption is still evidence.
--
-- Idempotent; documented rollback. Depends on: 0099 (evidence_photo).

alter table geo.evidence_photo
  add column if not exists caption text,
  add column if not exists ai_description text,
  -- Which observation this photograph belongs to, so the report can group images
  -- under the outcrop they were taken of instead of listing them in upload order.
  --
  -- The device's own observation id (a waypoint id), text and not a foreign key:
  -- observations live inside `mission_package.payload` as JSON, not as rows, so
  -- there is nothing here to reference. When they become rows this becomes an FK.
  add column if not exists observation_id text;

create index if not exists evidence_photo_observation_idx
  on geo.evidence_photo (mission_id, observation_id)
  where observation_id is not null;

comment on column geo.evidence_photo.caption is
  'The geologist''s own words. Never overwritten by a model.';
comment on column geo.evidence_photo.ai_description is
  'What a model read from the image. An interpretation — label it as one.';

-- ── Intake ──────────────────────────────────────────────────────────────────
-- Only the photo loop changes: the caption and the owning observation are carried
-- from the package. Everything else is 0102's body unchanged.
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
  v_type text;
begin
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

  for v_obs in select * from jsonb_array_elements(coalesce(p_package->'observations', '[]'::jsonb))
  loop
    for v_photo in select * from jsonb_array_elements(coalesce(v_obs->'photos', '[]'::jsonb))
    loop
      v_type := coalesce(nullif(v_photo->>'contentType', ''), 'image/jpeg');

      insert into geo.evidence_photo (
        id, mission_id, user_id, r2_key, content_type, lat, lng,
        gps_accuracy_m, heading_deg, position_quality, captured_at,
        observation_id, caption
      ) values (
        v_photo->>'id',
        v_mission_id,
        p_actor,
        geo.photo_key(v_mission_id, v_photo->>'id', v_type),
        v_type,
        (v_obs->'position'->>'lat')::double precision,
        (v_obs->'position'->>'lng')::double precision,
        (v_obs->'position'->>'accuracyM')::double precision,
        (v_obs->>'headingDeg')::double precision,
        v_obs->>'positionQuality',
        to_timestamp((v_photo->>'capturedAt')::bigint / 1000.0),
        nullif(v_obs->>'id', ''),
        -- The photograph's own caption when it has one, otherwise the
        -- observation's notes. Both are the geologist's words; neither is a
        -- model's. `ai_description` is written by the analysis, never here.
        coalesce(nullif(v_photo->>'caption', ''), nullif(v_obs->>'notes', ''))
      )
      on conflict (id) do update set
        caption = coalesce(excluded.caption, geo.evidence_photo.caption),
        observation_id = coalesce(excluded.observation_id, geo.evidence_photo.observation_id);
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

-- ── VERIFY (CI/CD) — expect columns=3 ──────────────────────────────────────
--   select count(*) from information_schema.columns
--    where table_schema='geo' and table_name='evidence_photo'
--      and column_name in ('caption','ai_description','observation_id');   -- expect 3

-- ── ROLLBACK (down-path) ───────────────────────────────────────────────────
--   \i supabase/migrations/0100_photo_key_content_type.sql   -- restores the RPC
--   drop index if exists geo.evidence_photo_observation_idx;
--   alter table geo.evidence_photo drop column if exists observation_id;
--   alter table geo.evidence_photo drop column if exists ai_description;
--   alter table geo.evidence_photo drop column if exists caption;

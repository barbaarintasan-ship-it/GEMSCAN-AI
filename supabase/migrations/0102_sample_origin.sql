-- 0102_sample_origin.sql
--
-- Two workflows stop sharing one table's meaning.
--
-- WHAT WAS WRONG
-- --------------
-- `enterprise.sample` served both a geologist's personal collection and the
-- evidence of a field mission, with nothing recording which was which. The
-- consequences were not cosmetic: `analyze-sample` runs the GeoContext spatial
-- providers for EVERY sample, so a rock photographed at home was being given a
-- mapped-geology reading, nearby-occurrence evidence and a structural context for
-- wherever the phone happened to be. A personal collection was quietly being told
-- things about prospectivity that nobody asked it to say.
--
-- WHY A COLUMN AND NOT A SECOND TABLE
-- -----------------------------------
-- A separate `personal_sample` table would duplicate media, status, revisions,
-- review, the offline store, the list and the detail screen — and every one of
-- those would then have two implementations free to drift. The two workflows do
-- not differ in what a sample IS; they differ in what may be inferred from it.
-- That is a discriminator, not a schema.
--
-- WHY NOT DERIVE IT FROM `expedition_id IS NULL`
-- ----------------------------------------------
-- Because "has no expedition" and "is personal" are different statements. A
-- sample taken during a walk but not tied to a mission would silently be filed as
-- personal, and a NULL left by a sync that dropped the link would silently
-- reclassify real exploration evidence. `origin` is a fact the device asserts at
-- capture, not an inference drawn from an absence.
--
-- BACKFILL: NONE, AND THAT IS CORRECT
-- -----------------------------------
-- Every existing row defaults to 'personal'. The exploration path has never
-- written a sample — `expedition_id` and `mission_id` have sat unwritten since
-- they were added — so there is no linkage to restore and nothing to guess at.
--
-- `area_id` stays NOT NULL. Personal samples keep landing in the catch-all area
-- submit_sample creates; changing that would touch RLS and the review console for
-- no benefit now that `origin` carries the truth.
--
-- Idempotent; documented rollback. Depends on: 0023 (sample), 0069 (submit_sample).

-- ── The discriminator ───────────────────────────────────────────────────────
do $$ begin create type enterprise.sample_origin as enum ('personal','exploration');
exception when duplicate_object then null; end $$;

alter table enterprise.sample
  add column if not exists origin enterprise.sample_origin not null default 'personal',
  -- The DEVICE's mission id (geo.field_mission.id, text `ms-…`).
  --
  -- NOT a foreign key, and not `mission_id`. Two different things are called a
  -- mission in this system: `enterprise.exploration_mission` is a uuid and a PLAN
  -- made in the console; `geo.field_mission` is a text id minted offline on a
  -- phone. They are not interchangeable, and pointing this at the uuid one would
  -- record a relationship that does not exist.
  --
  -- No FK even to geo.field_mission: a sample can sync before the package that
  -- creates the mission row, and a constraint would reject a perfectly good
  -- record for arriving in the order the field actually produces it.
  add column if not exists field_mission_id text;

create index if not exists idx_sample_origin
  on enterprise.sample (created_by, origin, collected_at desc)
  where deleted_at is null;

create index if not exists idx_sample_field_mission
  on enterprise.sample (field_mission_id)
  where field_mission_id is not null;

comment on column enterprise.sample.origin is
  'personal = a collected specimen, no spatial inference permitted. '
  'exploration = evidence of a field mission. See analyze-sample lane split.';

-- ── Intake ──────────────────────────────────────────────────────────────────
-- Unchanged from 0069 except for the two new columns on the insert. The signature
-- is identical, so every existing caller keeps working and a payload that says
-- nothing about origin still produces exactly what it produced before.

create or replace function enterprise.submit_sample(p_actor uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = enterprise, extensions, pg_temp
as $$
declare
  v_area uuid;
  v_sample uuid;
  v_name text := btrim(coalesce(p_payload->>'name',''));
  v_lng double precision := nullif(p_payload->>'lng','')::double precision;
  v_lat double precision := nullif(p_payload->>'lat','')::double precision;
  v_pt  extensions.geography;
  v_media_count int := 0;
  v_obs_count int := 0;
  v_context_photos int := 0;
  v_closeup_photos int := 0;
  o jsonb;
  el jsonb;
begin
  -- ── VALIDATION — only name + GPS + photos are required ─────────────────────
  if v_name = '' then raise exception 'validation: sample name is required'; end if;
  if v_lat is null or v_lng is null then raise exception 'validation: GPS (lat/lng) is required'; end if;
  if v_lat < -90 or v_lat > 90 or v_lng < -180 or v_lng > 180 then
    raise exception 'validation: GPS coordinates out of range'; end if;
  if (p_payload->>'h3_cell') is null then raise exception 'validation: h3_cell is required'; end if;
  if (p_payload->>'collected_at') is null then raise exception 'validation: collection date is required'; end if;

  for el in select * from jsonb_array_elements(coalesce(p_payload->'media','[]'::jsonb)) loop
    if (el->>'role') = 'context' then v_context_photos := v_context_photos + 1; end if;
    if (el->>'role') in ('surface_closeup','texture_structure','key_feature') then
      v_closeup_photos := v_closeup_photos + 1; end if;
  end loop;
  if v_context_photos = 0 then raise exception 'validation: a field-context photo is required'; end if;
  if v_closeup_photos = 0 then raise exception 'validation: a specimen close-up photo is required'; end if;

  v_pt := extensions.st_setsrid(extensions.st_makepoint(v_lng, v_lat), 4326)::extensions.geography;

  -- ── AREA (get-or-create owner default) ────────────────────────────────────
  if nullif(p_payload->>'area_id','') is not null then
    v_area := (p_payload->>'area_id')::uuid;
  else
    select id into v_area from enterprise.exploration_area
      where created_by = p_actor and name = 'Owner Beta Field Collection' limit 1;
    if v_area is null then
      insert into enterprise.exploration_area (name, center, project_id, created_by)
        values ('Owner Beta Field Collection', v_pt, null, p_actor) returning id into v_area;
    end if;
  end if;

  -- ── SAMPLE ────────────────────────────────────────────────────────────────
  insert into enterprise.sample (name, area_id, collector_id, created_by, collected_at,
      host_context, rock_condition, in_situ, geological_environment, terrain_type,
      weather_conditions, field_observations, sample_method, formation_id, status,
      origin, field_mission_id)
  values (v_name, v_area, p_actor, p_actor,
      (p_payload->>'collected_at')::timestamptz,
      nullif(p_payload->>'host_context',''), nullif(p_payload->>'rock_condition',''),
      (nullif(p_payload->>'in_situ',''))::boolean, nullif(p_payload->>'geological_environment',''),
      nullif(p_payload->>'terrain_type','')::terrain_type,
      nullif(p_payload->>'weather_conditions',''), nullif(p_payload->>'field_observations',''),
      nullif(p_payload->>'sample_method','')::sample_method,
      nullif(p_payload->>'formation_id','')::uuid,
      'submitted',
      -- DEFAULTS TO PERSONAL, deliberately.
      --
      -- A sample whose origin nobody stated is a rock somebody picked up, not a
      -- mission's evidence. Guessing the other way would file private collecting
      -- into an exploration record; guessing this way is only ever wrong in the
      -- direction of saying less than we know.
      coalesce(nullif(p_payload->>'origin','')::enterprise.sample_origin, 'personal'),
      nullif(p_payload->>'field_mission_id',''))
  returning id into v_sample;

  -- ── LOCATION ──────────────────────────────────────────────────────────────
  insert into enterprise.sample_location (sample_id, location, altitude_m, gps_accuracy_m, h3_cell, provenance)
  values (v_sample, v_pt, nullif(p_payload->>'altitude_m','')::double precision,
      nullif(p_payload->>'gps_accuracy_m','')::double precision, p_payload->>'h3_cell',
      coalesce(nullif(p_payload->>'gps_source','')::gps_source, 'gps'));

  -- ── MEDIA ─────────────────────────────────────────────────────────────────
  for el in select * from jsonb_array_elements(coalesce(p_payload->'media','[]'::jsonb)) loop
    insert into enterprise.sample_media (sample_id, role, storage_path, thumb_path, width, height, image_quality_score, exif)
    values (v_sample, (el->>'role')::media_role, el->>'storage_path', nullif(el->>'thumb_path',''),
        nullif(el->>'width','')::int, nullif(el->>'height','')::int,
        nullif(el->>'image_quality_score','')::numeric, el->'exif');
    v_media_count := v_media_count + 1;
  end loop;

  -- ── OBSERVATIONS — all OPTIONAL (inserted only when present) ───────────────
  o := coalesce(p_payload->'observations', '{}'::jsonb);

  if (o ? 'rock') and (o->'rock' <> 'null'::jsonb)
     and btrim(coalesce(o->'rock'->>'rock_class','')) <> '' then
    insert into enterprise.rock_observation (sample_id, rock_class, host_type, texture, weathering, vein_presence, notes, method)
    values (v_sample, o->'rock'->>'rock_class', nullif(o->'rock'->>'host_type',''), nullif(o->'rock'->>'texture',''),
        nullif(o->'rock'->>'weathering',''), (nullif(o->'rock'->>'vein_presence',''))::boolean,
        nullif(o->'rock'->>'notes',''), 'field');
    v_obs_count := v_obs_count + 1;
  end if;

  for el in select * from jsonb_array_elements(coalesce(o->'minerals','[]'::jsonb)) loop
    if btrim(coalesce(el->>'mineral','')) = '' then continue; end if;
    insert into enterprise.mineral_observation (sample_id, mineral, confidence, method)
    values (v_sample, el->>'mineral', nullif(el->>'confidence','')::numeric, 'field');
    v_obs_count := v_obs_count + 1;
  end loop;

  if (o ? 'alteration') and (o->'alteration' <> 'null'::jsonb)
     and btrim(coalesce(o->'alteration'->>'alteration_type','')) <> '' then
    insert into enterprise.alteration_observation (sample_id, alteration_type, intensity, notes, method)
    values (v_sample, nullif(o->'alteration'->>'alteration_type','')::alteration_type,
        nullif(o->'alteration'->>'intensity','')::alteration_grade, nullif(o->'alteration'->>'notes',''), 'field');
    v_obs_count := v_obs_count + 1;
  end if;

  for el in select * from jsonb_array_elements(coalesce(o->'structural','[]'::jsonb)) loop
    if btrim(coalesce(el->>'structure_type','')) = '' then continue; end if;
    insert into enterprise.structural_measurement (sample_id, structure_type, strike_deg, dip_deg, dip_direction, notes)
    values (v_sample, nullif(el->>'structure_type','')::structure_type, nullif(el->>'strike_deg','')::numeric,
        nullif(el->>'dip_deg','')::numeric, nullif(el->>'dip_direction','')::numeric, nullif(el->>'notes',''));
    v_obs_count := v_obs_count + 1;
  end loop;

  -- ── INITIAL REVISION + AUDIT ──────────────────────────────────────────────
  insert into enterprise.sample_revision (sample_id, revision_no, edited_by, change_summary, snapshot)
  values (v_sample, 1, p_actor, 'initial submission',
      jsonb_build_object('name', v_name, 'area_id', v_area, 'lat', v_lat, 'lng', v_lng,
          'collected_at', p_payload->>'collected_at', 'media_count', v_media_count,
          'observation_count', v_obs_count, 'observations', o, 'status', 'submitted'));

  insert into enterprise.audit_log (actor_id, action, entity_type, entity_id, after, context)
  values (p_actor, 'insert', 'sample', v_sample,
      jsonb_build_object('name', v_name, 'area_id', v_area, 'media', v_media_count, 'observations', v_obs_count),
      jsonb_build_object('source','enterprise-samples','beta',true));

  return jsonb_build_object('sample_id', v_sample, 'area_id', v_area,
      'media_count', v_media_count, 'observation_count', v_obs_count);
end;
$$;

-- ── VERIFY (CI/CD) — expect columns=2, indexes=2, enum=2 ───────────────────
--   select
--     (select count(*) from information_schema.columns where table_schema='enterprise'
--        and table_name='sample' and column_name in ('origin','field_mission_id')) as columns,
--     (select count(*) from pg_indexes where schemaname='enterprise'
--        and indexname in ('idx_sample_origin','idx_sample_field_mission')) as indexes,
--     (select count(*) from pg_enum e join pg_type t on t.oid=e.enumtypid
--        where t.typname='sample_origin') as enum_values;
--   -- and: every existing row is personal
--   select count(*) filter (where origin <> 'personal') from enterprise.sample;  -- expect 0

-- ── ROLLBACK (down-path) ───────────────────────────────────────────────────
--   \i supabase/migrations/0069_submit_sample_ai_first.sql   -- restores the RPC
--   drop index if exists enterprise.idx_sample_field_mission;
--   drop index if exists enterprise.idx_sample_origin;
--   alter table enterprise.sample drop column if exists field_mission_id;
--   alter table enterprise.sample drop column if exists origin;
--   drop type if exists enterprise.sample_origin;

-- 0110_submit_sample_obs_method.sql
--
-- enterprise.submit_sample: let the caller state the OBSERVATION METHOD for the
-- rock (and minerals), instead of hard-coding 'field'.
--
-- WHY. The Scan → Sample bridge pre-fills the Host rock from the app's photo
-- identification. That is a MACHINE guess, not a field observation — and the
-- honesty of the whole pipeline depends on the two never being confused. The
-- `enterprise.obs_method` enum already distinguishes 'field' | 'ai' | 'expert';
-- this migration simply lets it be set at submit time:
--   * scanned/pre-filled host rock  → method='ai'  (a candidate, editable)
--   * a value the collector typed    → method='field'
--   * a geologist's correction       → method='expert' (via review, unchanged)
--
-- The engine still reads whatever `rock_class` is saved; provenance rides
-- alongside so the UI can label an unconfirmed AI guess and never present it as
-- verified certainty. DEFAULT stays 'field', so every existing caller that sends
-- no method behaves exactly as before.
--
-- This is a verbatim re-declaration of the 0102 body with the two method values
-- made payload-driven. No signature change, no new column. Idempotent.
-- Depends on: 0102 (submit_sample + origin), 0023 (obs_method / rock_observation).

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
        nullif(o->'rock'->>'notes',''),
        coalesce(nullif(o->'rock'->>'method','')::enterprise.obs_method, 'field'));
    v_obs_count := v_obs_count + 1;
  end if;

  for el in select * from jsonb_array_elements(coalesce(o->'minerals','[]'::jsonb)) loop
    if btrim(coalesce(el->>'mineral','')) = '' then continue; end if;
    insert into enterprise.mineral_observation (sample_id, mineral, confidence, method)
    values (v_sample, el->>'mineral', nullif(el->>'confidence','')::numeric,
        coalesce(nullif(el->>'method','')::enterprise.obs_method, 'field'));
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

-- ── VERIFY ─────────────────────────────────────────────────────────────────
--   select o->'rock'->>'method' as sent, method as stored ... after a submit
--   with observations.rock.method='ai' → expect stored 'ai'; omit → 'field'.

-- ── ROLLBACK ───────────────────────────────────────────────────────────────
--   \i supabase/migrations/0102_sample_origin.sql   -- restores the 'field' hard-code

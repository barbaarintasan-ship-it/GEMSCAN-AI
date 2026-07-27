-- 0063_submit_sample_validated.sql
--
-- Sprint 4.2.1 — replace enterprise.submit_sample with a VALIDATED version (§4, §15).
-- Adds: required-field enforcement (defense-in-depth; the Edge Function validates
-- first and returns 400, this is the last line so even a direct RPC call cannot
-- create an empty/partial sample), the human sample `name`, and an initial
-- append-only revision snapshot (§8). Errors are raised with a 'validation:'
-- prefix so callers can distinguish a bad request from a server fault.
--
-- Required to create a sample: name, lat/lng, h3_cell, collected_at, host rock
-- (rock_class), >=1 mineral observation, >=1 context photo AND >=1 close-up photo.
--
-- SECURITY DEFINER + pinned search_path (needs extensions.* for PostGIS).

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
  v_lng double precision := (p_payload->>'lng')::double precision;
  v_lat double precision := (p_payload->>'lat')::double precision;
  v_pt  extensions.geography;
  v_media_count int := 0;
  v_obs_count int := 0;
  v_mineral_count int := 0;
  v_context_photos int := 0;
  v_closeup_photos int := 0;
  v_has_rock boolean := false;
  el jsonb;
  o jsonb;
begin
  -- ── VALIDATION (§4/§15 defense-in-depth) ──────────────────────────────────
  if v_name = '' then raise exception 'validation: sample name is required'; end if;
  if v_lat is null or v_lng is null then raise exception 'validation: GPS (lat/lng) is required'; end if;
  if v_lat < -90 or v_lat > 90 or v_lng < -180 or v_lng > 180 then
    raise exception 'validation: GPS coordinates out of range'; end if;
  if (p_payload->>'h3_cell') is null then raise exception 'validation: h3_cell is required'; end if;
  if (p_payload->>'collected_at') is null then raise exception 'validation: collection date is required'; end if;

  o := coalesce(p_payload->'observations', '{}'::jsonb);
  v_has_rock := (o ? 'rock') and (o->'rock' <> 'null'::jsonb)
                and btrim(coalesce(o->'rock'->>'rock_class','')) <> '';
  if not v_has_rock then raise exception 'validation: host rock is required'; end if;

  select count(*) into v_mineral_count
    from jsonb_array_elements(coalesce(o->'minerals','[]'::jsonb)) m
    where btrim(coalesce(m->>'mineral','')) <> '';
  if v_mineral_count = 0 then raise exception 'validation: at least one mineral observation is required'; end if;

  -- photo minimums: one field-context photo + one specimen close-up (§3)
  for el in select * from jsonb_array_elements(coalesce(p_payload->'media','[]'::jsonb)) loop
    if (el->>'role') = 'context' then v_context_photos := v_context_photos + 1; end if;
    if (el->>'role') in ('surface_closeup','texture_structure','key_feature') then
      v_closeup_photos := v_closeup_photos + 1; end if;
  end loop;
  if v_context_photos = 0 then raise exception 'validation: a field-context photo is required'; end if;
  if v_closeup_photos = 0 then raise exception 'validation: a specimen close-up photo is required'; end if;

  v_pt := extensions.st_setsrid(extensions.st_makepoint(v_lng, v_lat), 4326)::extensions.geography;

  -- ── AREA (get-or-create owner default) ────────────────────────────────────
  if (p_payload->>'area_id') is not null then
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
      weather_conditions, field_observations, sample_method, formation_id, status)
  values (v_name, v_area, p_actor, p_actor,
      (p_payload->>'collected_at')::timestamptz,
      p_payload->>'host_context', p_payload->>'rock_condition',
      (p_payload->>'in_situ')::boolean, p_payload->>'geological_environment',
      nullif(p_payload->>'terrain_type','')::terrain_type,
      p_payload->>'weather_conditions', p_payload->>'field_observations',
      nullif(p_payload->>'sample_method','')::sample_method,
      nullif(p_payload->>'formation_id','')::uuid,
      'submitted')
  returning id into v_sample;

  -- ── LOCATION ──────────────────────────────────────────────────────────────
  insert into enterprise.sample_location (sample_id, location, altitude_m, gps_accuracy_m, h3_cell, provenance)
  values (v_sample, v_pt, (p_payload->>'altitude_m')::double precision,
      (p_payload->>'gps_accuracy_m')::double precision, p_payload->>'h3_cell',
      coalesce(nullif(p_payload->>'gps_source','')::gps_source, 'gps'));

  -- ── MEDIA ─────────────────────────────────────────────────────────────────
  for el in select * from jsonb_array_elements(coalesce(p_payload->'media','[]'::jsonb)) loop
    insert into enterprise.sample_media (sample_id, role, storage_path, thumb_path, width, height, image_quality_score, exif)
    values (v_sample, (el->>'role')::media_role, el->>'storage_path', el->>'thumb_path',
        (el->>'width')::int, (el->>'height')::int, (el->>'image_quality_score')::numeric, el->'exif');
    v_media_count := v_media_count + 1;
  end loop;

  -- ── OBSERVATIONS ──────────────────────────────────────────────────────────
  insert into enterprise.rock_observation (sample_id, rock_class, host_type, texture, weathering, vein_presence, notes, method)
  values (v_sample, o->'rock'->>'rock_class', o->'rock'->>'host_type', o->'rock'->>'texture',
      o->'rock'->>'weathering', (o->'rock'->>'vein_presence')::boolean, o->'rock'->>'notes', 'field');
  v_obs_count := v_obs_count + 1;

  for el in select * from jsonb_array_elements(coalesce(o->'minerals','[]'::jsonb)) loop
    if btrim(coalesce(el->>'mineral','')) = '' then continue; end if;
    insert into enterprise.mineral_observation (sample_id, mineral, confidence, method)
    values (v_sample, el->>'mineral', (el->>'confidence')::numeric, 'field');
    v_obs_count := v_obs_count + 1;
  end loop;

  if o ? 'alteration' and o->'alteration' <> 'null'::jsonb then
    insert into enterprise.alteration_observation (sample_id, alteration_type, intensity, notes, method)
    values (v_sample, nullif(o->'alteration'->>'alteration_type','')::alteration_type,
        nullif(o->'alteration'->>'intensity','')::alteration_grade, o->'alteration'->>'notes', 'field');
    v_obs_count := v_obs_count + 1;
  end if;

  for el in select * from jsonb_array_elements(coalesce(o->'structural','[]'::jsonb)) loop
    insert into enterprise.structural_measurement (sample_id, structure_type, strike_deg, dip_deg, dip_direction, notes)
    values (v_sample, nullif(el->>'structure_type','')::structure_type, (el->>'strike_deg')::numeric,
        (el->>'dip_deg')::numeric, (el->>'dip_direction')::numeric, el->>'notes');
    v_obs_count := v_obs_count + 1;
  end loop;

  -- ── INITIAL REVISION (§8) ─────────────────────────────────────────────────
  insert into enterprise.sample_revision (sample_id, revision_no, edited_by, change_summary, snapshot)
  values (v_sample, 1, p_actor, 'initial submission',
      jsonb_build_object('name', v_name, 'area_id', v_area, 'lat', v_lat, 'lng', v_lng,
          'collected_at', p_payload->>'collected_at', 'media_count', v_media_count,
          'observation_count', v_obs_count, 'observations', o, 'status', 'submitted'));

  -- ── AUDIT (append-only) ───────────────────────────────────────────────────
  insert into enterprise.audit_log (actor_id, action, entity_type, entity_id, after, context)
  values (p_actor, 'insert', 'sample', v_sample,
      jsonb_build_object('name', v_name, 'area_id', v_area, 'media', v_media_count, 'observations', v_obs_count),
      jsonb_build_object('source','enterprise-samples','beta',true));

  return jsonb_build_object('sample_id', v_sample, 'area_id', v_area,
      'media_count', v_media_count, 'observation_count', v_obs_count);
end;
$$;

revoke all on function enterprise.submit_sample(uuid, jsonb) from public;
grant execute on function enterprise.submit_sample(uuid, jsonb) to service_role;

-- ── VERIFY — a payload missing name/photos/rock must RAISE 'validation: …' ──
--   select enterprise.submit_sample('00000000-0000-0000-0000-000000000001'::uuid,
--     '{"lat":2,"lng":45}'::jsonb);   -- expect: ERROR validation: sample name is required

-- ── ROLLBACK ──  (restore the 0059 body)
--   see 0059_enterprise_submit_sample.sql

-- 0059_enterprise_submit_sample.sql
--
-- Sprint 4.2 — atomic Sample Submission RPC (owner beta).
--
-- enterprise.submit_sample(actor, payload) creates a sample + its GPS location +
-- observations + media links + an audit_log entry in ONE transaction (all-or-nothing).
-- Called by the enterprise-samples Edge Function with the service role AFTER
-- resolveActor + requireEnterprise. Writes stay service-only (grant to service_role;
-- NOT authenticated), consistent with the Sprint 3 model. PostGIS geography is built
-- in SQL (ST_MakePoint) to avoid PostgREST casting issues.
--
-- SECURITY DEFINER + pinned search_path (needs extensions.* for PostGIS). Additive;
-- frozen tables untouched. Idempotent.

create or replace function enterprise.submit_sample(p_actor uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = enterprise, extensions, pg_temp
as $$
declare
  v_area uuid;
  v_sample uuid;
  v_lng double precision := (p_payload->>'lng')::double precision;
  v_lat double precision := (p_payload->>'lat')::double precision;
  v_pt  extensions.geography := extensions.st_setsrid(extensions.st_makepoint(v_lng, v_lat), 4326)::extensions.geography;
  v_media_count int := 0;
  v_obs_count int := 0;
  el jsonb;
  o jsonb;
begin
  if v_lat is null or v_lng is null then raise exception 'lat/lng required'; end if;
  if (p_payload->>'h3_cell') is null then raise exception 'h3_cell required'; end if;

  -- get-or-create the owner's default community area (project_id null) unless given
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

  -- sample
  insert into enterprise.sample (area_id, collector_id, created_by, collected_at,
      host_context, rock_condition, in_situ, geological_environment, terrain_type,
      weather_conditions, field_observations, sample_method, formation_id)
  values (v_area, p_actor, p_actor,
      coalesce((p_payload->>'collected_at')::timestamptz, now()),
      p_payload->>'host_context', p_payload->>'rock_condition',
      (p_payload->>'in_situ')::boolean, p_payload->>'geological_environment',
      nullif(p_payload->>'terrain_type','')::terrain_type,
      p_payload->>'weather_conditions', p_payload->>'field_observations',
      nullif(p_payload->>'sample_method','')::sample_method,
      nullif(p_payload->>'formation_id','')::uuid)
  returning id into v_sample;

  -- location
  insert into enterprise.sample_location (sample_id, location, altitude_m, gps_accuracy_m, h3_cell, provenance)
  values (v_sample, v_pt, (p_payload->>'altitude_m')::double precision,
      (p_payload->>'gps_accuracy_m')::double precision, p_payload->>'h3_cell',
      coalesce(nullif(p_payload->>'gps_source','')::gps_source, 'gps'));

  -- media
  for el in select * from jsonb_array_elements(coalesce(p_payload->'media','[]'::jsonb)) loop
    insert into enterprise.sample_media (sample_id, role, storage_path, thumb_path, width, height, image_quality_score, exif)
    values (v_sample, (el->>'role')::media_role, el->>'storage_path', el->>'thumb_path',
        (el->>'width')::int, (el->>'height')::int, (el->>'image_quality_score')::numeric, el->'exif');
    v_media_count := v_media_count + 1;
  end loop;

  -- observations
  o := p_payload->'observations';
  if o ? 'rock' and o->'rock' <> 'null'::jsonb then
    insert into enterprise.rock_observation (sample_id, rock_class, host_type, texture, weathering, vein_presence, notes, method)
    values (v_sample, o->'rock'->>'rock_class', o->'rock'->>'host_type', o->'rock'->>'texture',
        o->'rock'->>'weathering', (o->'rock'->>'vein_presence')::boolean, o->'rock'->>'notes', 'field');
    v_obs_count := v_obs_count + 1;
  end if;
  for el in select * from jsonb_array_elements(coalesce(o->'minerals','[]'::jsonb)) loop
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

  -- audit (append-only ledger)
  insert into enterprise.audit_log (actor_id, action, entity_type, entity_id, after, context)
  values (p_actor, 'insert', 'sample', v_sample,
      jsonb_build_object('area_id', v_area, 'media', v_media_count, 'observations', v_obs_count),
      jsonb_build_object('source','enterprise-samples','beta',true));

  return jsonb_build_object('sample_id', v_sample, 'area_id', v_area,
      'media_count', v_media_count, 'observation_count', v_obs_count);
end;
$$;

revoke all on function enterprise.submit_sample(uuid, jsonb) from public;
grant execute on function enterprise.submit_sample(uuid, jsonb) to service_role;

-- ── VERIFY — expect: fn=1, exec_to_service=1, exec_to_authenticated=0 ───────
--   select
--     (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='enterprise' and p.proname='submit_sample') as fn,
--     has_function_privilege('service_role','enterprise.submit_sample(uuid,jsonb)','execute') as svc,
--     has_function_privilege('authenticated','enterprise.submit_sample(uuid,jsonb)','execute') as auth;

-- ── ROLLBACK ──
--   drop function if exists enterprise.submit_sample(uuid, jsonb);

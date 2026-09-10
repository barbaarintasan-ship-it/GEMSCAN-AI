-- 0118_submit_sample_mission_context.sql
--
-- Phase 2C — the actual connection point. submit_sample() is the ONE place a
-- sample gets created (personal or enterprise); this replaces it in place
-- (same signature, same return shape) to additionally accept optional
-- mission context, validate it server-side, and populate the two dead/new
-- columns from 0117. Every existing call with no mission fields in the
-- payload behaves byte-for-byte as before — every new block below is gated
-- on `v_mission is not null`.
--
-- Payload keys this RPC now also reads (both OPTIONAL):
--   enterprise_mission_id — the enterprise.exploration_mission uuid. Named
--     deliberately UNLIKE the existing `field_mission_id` (a text id for the
--     unrelated SOLO geo.field_mission) so the two can never be confused at
--     the payload level, matching the brief's "keep the distinction
--     absolutely clear."
--   assignment_h3 — the sample's H3 cell at the mission-assignment
--     resolution (7), computed SERVER-SIDE in enterprise-samples/handler.ts
--     from the same server-verified lat/lng that already produces the
--     existing `h3_cell` (resolution 9) — never client-trusted, exactly
--     like h3_cell already isn't. Required only when enterprise_mission_id
--     is present.
--   location_origin — 'observed' | 'reported', defaults to 'observed'
--     (0117). Purely descriptive; never changes which coordinate is stored.
--
-- Authorization note: submit_sample runs SECURITY DEFINER via an explicit
-- p_actor (called with the SERVICE ROLE from enterprise-samples/handler.ts,
-- which already verified the caller's JWT via resolveActor). auth.uid() is
-- NOT available in that execution context (no JWT claims flow through a
-- service-role call), so the mission-membership check below is inlined
-- against p_actor directly rather than reusing enterprise.is_mission_member()
-- (which reads auth.uid() and would silently evaluate false here).

create or replace function enterprise.submit_sample(p_actor uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = enterprise, extensions, pg_temp
as $$
declare
  v_area uuid;
  v_area_count integer;
  v_sample uuid;
  v_name text := btrim(coalesce(p_payload->>'name',''));
  v_lng double precision := nullif(p_payload->>'lng','')::double precision;
  v_lat double precision := nullif(p_payload->>'lat','')::double precision;
  v_pt  extensions.geography;
  v_media_count int := 0;
  v_obs_count int := 0;
  v_context_photos int := 0;
  v_closeup_photos int := 0;
  v_mission uuid;
  v_mission_status enterprise.mission_status;
  v_assignment_h3 text;
  v_explicit_area uuid;
  v_outside_assignment boolean;
  v_location_origin text := coalesce(nullif(p_payload->>'location_origin',''), 'observed');
  o jsonb;
  el jsonb;
begin
  if v_name = '' then raise exception 'validation: sample name is required'; end if;
  if v_lat is null or v_lng is null then raise exception 'validation: GPS (lat/lng) is required'; end if;
  if v_lat < -90 or v_lat > 90 or v_lng < -180 or v_lng > 180 then
    raise exception 'validation: GPS coordinates out of range'; end if;
  if (p_payload->>'h3_cell') is null then raise exception 'validation: h3_cell is required'; end if;
  if (p_payload->>'collected_at') is null then raise exception 'validation: collection date is required'; end if;
  if v_location_origin not in ('observed', 'reported') then
    raise exception 'validation: location_origin must be observed or reported'; end if;

  for el in select * from jsonb_array_elements(coalesce(p_payload->'media','[]'::jsonb)) loop
    if (el->>'role') = 'context' then v_context_photos := v_context_photos + 1; end if;
    if (el->>'role') in ('surface_closeup','texture_structure','key_feature') then
      v_closeup_photos := v_closeup_photos + 1; end if;
  end loop;
  if v_context_photos = 0 then raise exception 'validation: a field-context photo is required'; end if;
  if v_closeup_photos = 0 then raise exception 'validation: a specimen close-up photo is required'; end if;

  v_pt := extensions.st_setsrid(extensions.st_makepoint(v_lng, v_lat), 4326)::extensions.geography;

  -- ── Enterprise mission context (all new, all optional) ────────────────────
  v_mission := nullif(p_payload->>'enterprise_mission_id', '')::uuid;
  v_explicit_area := nullif(p_payload->>'area_id', '')::uuid;

  if v_mission is not null then
    select status into v_mission_status from enterprise.exploration_mission where id = v_mission;
    if not found then
      raise exception 'validation: enterprise mission % not found', v_mission;
    end if;
    if v_mission_status not in ('planned', 'active') then
      raise exception 'validation: mission % is not open for collection (status: %)', v_mission, v_mission_status;
    end if;

    -- Membership check inlined against p_actor (see header note — auth.uid()
    -- does not resolve in this service-role execution context).
    if not exists (
      select 1 from enterprise.exploration_mission m where m.id = v_mission and m.owner_id = p_actor
      union all
      select 1 from enterprise.mission_contributor mc where mc.mission_id = v_mission and mc.contributor_id = p_actor
    ) then
      raise exception 'forbidden: % is not a contributor on mission %', p_actor, v_mission;
    end if;

    v_assignment_h3 := nullif(p_payload->>'assignment_h3', '');
    if v_assignment_h3 is null then
      raise exception 'validation: assignment_h3 is required for a mission sample';
    end if;

    -- An explicit area_id under a mission must actually belong to that
    -- mission — never trust it just because the client sent one.
    if v_explicit_area is not null and not exists (
      select 1 from enterprise.mission_area where mission_id = v_mission and area_id = v_explicit_area
    ) then
      raise exception 'validation: area % is not linked to mission %', v_explicit_area, v_mission;
    end if;

    -- Outside-primary-assignment flag (Step 5): does p_actor hold an ACTIVE
    -- assignment for the cell the evidence was ACTUALLY found in? Recorded,
    -- never blocking — geology does not respect H3 boundaries.
    v_outside_assignment := not exists (
      select 1 from enterprise.mission_assignment ma
      where ma.mission_id = v_mission
        and ma.target_h3 = v_assignment_h3
        and ma.contributor_id = p_actor
        and ma.status not in ('completed', 'skipped', 'expired')
    );
  end if;

  -- ── area_id resolution ──────────────────────────────────────────────────
  if v_explicit_area is not null then
    v_area := v_explicit_area;
  elsif v_mission is not null then
    -- 1) The area that generated the exact cell this evidence fell in
    --    (mission_assignment.area_id, Phase 2B provenance) — the common,
    --    "inside your assignment" case.
    select ma.area_id into v_area
      from enterprise.mission_assignment ma
      where ma.mission_id = v_mission and ma.target_h3 = v_assignment_h3
      limit 1;

    -- 2) Not a pre-generated cell (an out-of-assignment discovery, Step 5) —
    --    fall back to genuine spatial containment against the mission's
    --    linked areas. PostGIS, not H3 — deterministic, no guessing.
    if v_area is null then
      select ea.id into v_area
        from enterprise.mission_area ma2
        join enterprise.exploration_area ea on ea.id = ma2.area_id
        where ma2.mission_id = v_mission
          and ea.boundary is not null
          and extensions.ST_Contains(ea.boundary::extensions.geometry, v_pt::extensions.geometry)
        order by ea.id
        limit 1;
    end if;

    -- 3) Still nothing — only safe to guess when the mission has exactly ONE
    --    linked area (unambiguous). Two+ areas with no spatial match is a
    --    real ambiguity; per the brief, STOP and report rather than pick one.
    if v_area is null then
      select count(*), min(ma3.area_id) into v_area_count, v_area
        from enterprise.mission_area ma3 where ma3.mission_id = v_mission;
      if v_area_count <> 1 then
        raise exception
          'validation: cannot determine area_id for mission % — the location matches no linked area and % areas are linked; specify area_id explicitly',
          v_mission, v_area_count;
      end if;
    end if;
  else
    -- Unchanged personal-sample default: a per-user auto-created capture area.
    select id into v_area from enterprise.exploration_area
      where created_by = p_actor and name = 'Owner Beta Field Collection' limit 1;
    if v_area is null then
      insert into enterprise.exploration_area (name, center, project_id, created_by)
        values ('Owner Beta Field Collection', v_pt, null, p_actor) returning id into v_area;
    end if;
  end if;

  insert into enterprise.sample (name, area_id, mission_id, outside_assignment, collector_id, created_by, collected_at,
      host_context, rock_condition, in_situ, geological_environment, terrain_type,
      weather_conditions, field_observations, sample_method, formation_id, status,
      origin, field_mission_id)
  values (v_name, v_area, v_mission, v_outside_assignment, p_actor, p_actor,
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

  insert into enterprise.sample_location (sample_id, location, altitude_m, gps_accuracy_m, h3_cell, provenance, location_origin)
  values (v_sample, v_pt, nullif(p_payload->>'altitude_m','')::double precision,
      nullif(p_payload->>'gps_accuracy_m','')::double precision, p_payload->>'h3_cell',
      coalesce(nullif(p_payload->>'gps_source','')::gps_source, 'gps'),
      v_location_origin);

  for el in select * from jsonb_array_elements(coalesce(p_payload->'media','[]'::jsonb)) loop
    insert into enterprise.sample_media (sample_id, role, storage_path, thumb_path, width, height, image_quality_score, exif)
    values (v_sample, (el->>'role')::media_role, el->>'storage_path', nullif(el->>'thumb_path',''),
        nullif(el->>'width','')::int, nullif(el->>'height','')::int,
        nullif(el->>'image_quality_score','')::numeric, el->'exif');
    v_media_count := v_media_count + 1;
  end loop;

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

  insert into enterprise.sample_revision (sample_id, revision_no, edited_by, change_summary, snapshot)
  values (v_sample, 1, p_actor, 'initial submission',
      jsonb_build_object('name', v_name, 'area_id', v_area, 'lat', v_lat, 'lng', v_lng,
          'collected_at', p_payload->>'collected_at', 'media_count', v_media_count,
          'observation_count', v_obs_count, 'observations', o, 'status', 'submitted'));

  insert into enterprise.audit_log (actor_id, action, entity_type, entity_id, after, context)
  values (p_actor, 'insert', 'sample', v_sample,
      jsonb_build_object('name', v_name, 'area_id', v_area, 'media', v_media_count, 'observations', v_obs_count,
          'mission_id', v_mission, 'outside_assignment', v_outside_assignment),
      jsonb_build_object('source','enterprise-samples','beta',true));

  return jsonb_build_object('sample_id', v_sample, 'area_id', v_area,
      'media_count', v_media_count, 'observation_count', v_obs_count,
      'mission_id', v_mission, 'outside_assignment', v_outside_assignment);
end;
$$;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select pg_get_functiondef('enterprise.submit_sample(uuid,jsonb)'::regprocedure) ilike '%enterprise_mission_id%';

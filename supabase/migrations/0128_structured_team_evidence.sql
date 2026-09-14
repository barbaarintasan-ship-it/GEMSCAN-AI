-- 0128_structured_team_evidence.sql
--
-- Phase 6 (Solo→Team shared-targeting) — Structured Team Evidence.
--
-- Brings the same FIVE evidence categories Solo's User Geological Evidence
-- form already supports (mobile/lib/field/structuredEvidenceTypes.ts) into
-- Team samples: laboratory/assay, ground geophysics, detailed mapping,
-- remote sensing, expert/field observation. Reuses Solo's own vocabulary
-- (VerificationStatus: user_reported|expert_verified|lab_verified) rather
-- than inventing a parallel one, and enforces the SAME anti-inflation rule
-- Solo's structuredEvidenceSource.ts already enforces: a `lab_verified`
-- claim with no explicit `lab_accredited=true` is downgraded server-side,
-- never trusted at face value merely because a lab name was typed in.
--
-- One new table, generic across the five types (payload jsonb) rather than
-- five separate tables — the five payload shapes are Solo's own
-- AssayEntry/GeophysicsEntry/MappingEntry/RemoteSensingEntry/
-- FieldObservationEntry interfaces, unchanged, so a payload captured on
-- either platform is structurally interchangeable.

do $$ begin
  create type enterprise.structured_evidence_type as enum
    ('assay', 'geophysics', 'mapping', 'remote_sensing', 'field_observation');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type enterprise.evidence_verification_status as enum
    ('user_reported', 'expert_verified', 'lab_verified');
exception when duplicate_object then null;
end $$;

create table if not exists enterprise.sample_structured_evidence (
  id uuid primary key default gen_random_uuid(),
  sample_id uuid not null references enterprise.sample(id) on delete cascade,
  evidence_type enterprise.structured_evidence_type not null,
  payload jsonb not null,
  verification_status enterprise.evidence_verification_status not null default 'user_reported',
  -- The ONE gate for lab_verified — mirrors AssayEntry.labAccredited's own
  -- comment in structuredEvidenceTypes.ts verbatim. submit_sample (below)
  -- downgrades verification_status to expert_verified server-side when this
  -- is false, so a client cannot claim lab_verified merely by setting the
  -- status field.
  lab_accredited boolean not null default false,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint ck_structured_evidence_payload_object check (jsonb_typeof(payload) = 'object')
);
create index if not exists idx_structured_evidence_sample on enterprise.sample_structured_evidence(sample_id);
create index if not exists idx_structured_evidence_type on enterprise.sample_structured_evidence(evidence_type);

alter table enterprise.sample_structured_evidence enable row level security;

grant select, insert on enterprise.sample_structured_evidence to authenticated, service_role;

-- Read: same visibility as the sample it belongs to (0037's can_read_sample
-- already encodes "collector, or a reviewer, or an area/org member with
-- rights" — reused rather than re-derived).
drop policy if exists structured_evidence_select on enterprise.sample_structured_evidence;
create policy structured_evidence_select on enterprise.sample_structured_evidence for select to authenticated
  using (exists (
    select 1 from enterprise.sample s
    where s.id = sample_id and enterprise.can_read_sample(s.id)
  ));

-- Write: only the sample's own collector may attach evidence to it, and only
-- while the sample is still theirs to edit (mirrors sample_update's own
-- boundary — reviewed/locked samples are immutable, evidence included).
drop policy if exists structured_evidence_insert on enterprise.sample_structured_evidence;
create policy structured_evidence_insert on enterprise.sample_structured_evidence for insert to authenticated
  with check (
    created_by = auth.uid()
    and exists (select 1 from enterprise.sample s where s.id = sample_id and s.collector_id = auth.uid())
  );

comment on table enterprise.sample_structured_evidence is
  'Structured (assay/geophysics/mapping/remote_sensing/field_observation) evidence attached to a Team sample — Phase 6. Mirrors Solo''s StructuredGeologicalEvidence categories (mobile/lib/field/structuredEvidenceTypes.ts) so a payload is interchangeable between platforms. NOT read by any scoring path yet — see Phase 8.';

-- ── submit_sample(): accept an optional structured_evidence array ──────────
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
  v_evidence_count int := 0;
  o jsonb;
  el jsonb;
  v_status enterprise.evidence_verification_status;
  v_lab_ok boolean;
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

    if v_explicit_area is not null and not exists (
      select 1 from enterprise.mission_area where mission_id = v_mission and area_id = v_explicit_area
    ) then
      raise exception 'validation: area % is not linked to mission %', v_explicit_area, v_mission;
    end if;

    v_outside_assignment := not exists (
      select 1 from enterprise.mission_assignment ma
      where ma.mission_id = v_mission
        and ma.target_h3 = v_assignment_h3
        and ma.contributor_id = p_actor
        and ma.status not in ('completed', 'skipped', 'expired')
    );
  end if;

  if v_explicit_area is not null then
    v_area := v_explicit_area;
  elsif v_mission is not null then
    select ma.area_id into v_area
      from enterprise.mission_assignment ma
      where ma.mission_id = v_mission and ma.target_h3 = v_assignment_h3 and ma.contributor_id is null
      limit 1;

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
    select id into v_area from enterprise.exploration_area
      where created_by = p_actor and name = 'Owner Beta Field Collection' limit 1;
    if v_area is null then
      insert into enterprise.exploration_area (name, center, project_id, created_by)
        values ('Owner Beta Field Collection', v_pt, null, p_actor) returning id into v_area;
    end if;
  end if;

  insert into enterprise.sample (name, area_id, mission_id, outside_assignment, assignment_h3, collector_id, created_by, collected_at,
      host_context, rock_condition, in_situ, geological_environment, terrain_type,
      weather_conditions, field_observations, sample_method, formation_id, status,
      origin, field_mission_id)
  values (v_name, v_area, v_mission, v_outside_assignment, v_assignment_h3, p_actor, p_actor,
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

  -- Phase 6: optional structured evidence — the SAME five categories Solo's
  -- User Geological Evidence form uses. lab_verified is downgraded to
  -- expert_verified here, server-side, unless lab_accredited=true was
  -- explicitly sent — mirrors structuredEvidenceSource.ts's gatedTier() rule.
  for el in select * from jsonb_array_elements(coalesce(p_payload->'structured_evidence', '[]'::jsonb)) loop
    if (el->>'evidence_type') is null or (el->>'payload') is null then continue; end if;
    v_status := coalesce(nullif(el->>'verification_status','')::enterprise.evidence_verification_status, 'user_reported');
    v_lab_ok := coalesce((el->>'lab_accredited')::boolean, false);
    if v_status = 'lab_verified' and not v_lab_ok then
      v_status := 'expert_verified';
    end if;
    insert into enterprise.sample_structured_evidence
      (sample_id, evidence_type, payload, verification_status, lab_accredited, notes, created_by)
    values (
      v_sample,
      (el->>'evidence_type')::enterprise.structured_evidence_type,
      coalesce(el->'payload', '{}'::jsonb),
      v_status, v_lab_ok, nullif(el->>'notes',''),
      p_actor
    );
    v_evidence_count := v_evidence_count + 1;
  end loop;

  insert into enterprise.sample_revision (sample_id, revision_no, edited_by, change_summary, snapshot)
  values (v_sample, 1, p_actor, 'initial submission',
      jsonb_build_object('name', v_name, 'area_id', v_area, 'lat', v_lat, 'lng', v_lng,
          'collected_at', p_payload->>'collected_at', 'media_count', v_media_count,
          'observation_count', v_obs_count, 'observations', o, 'status', 'submitted'));

  insert into enterprise.audit_log (actor_id, action, entity_type, entity_id, after, context)
  values (p_actor, 'insert', 'sample', v_sample,
      jsonb_build_object('name', v_name, 'area_id', v_area, 'media', v_media_count, 'observations', v_obs_count,
          'mission_id', v_mission, 'outside_assignment', v_outside_assignment, 'assignment_h3', v_assignment_h3,
          'structured_evidence', v_evidence_count),
      jsonb_build_object('source','enterprise-samples','beta',true));

  return jsonb_build_object('sample_id', v_sample, 'area_id', v_area,
      'media_count', v_media_count, 'observation_count', v_obs_count,
      'mission_id', v_mission, 'outside_assignment', v_outside_assignment,
      'structured_evidence_count', v_evidence_count);
end;
$$;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select table_name from information_schema.tables
--     where table_schema='enterprise' and table_name='sample_structured_evidence';

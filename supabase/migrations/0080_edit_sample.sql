-- 0080_edit_sample.sql
--
-- Sprint 4.3 follow-on — let the collector EDIT a sample they submitted and
-- RE-SUBMIT it, as long as a geologist has not reviewed it yet. Editing changes
-- the field data and/or the photos, then the caller re-runs the Geological
-- Intelligence Engine (analyze-sample, force) so a FRESH assessment is produced.
--
-- "Only the latest is in the app" (product decision): each edit DELETES the prior
-- geological_assessment rows for the sample, so exactly one (the newest) ever
-- exists — the evidence graph (conclusions/evidence/edges, all `on delete cascade`
-- from 0064/0065) goes with it. The append-only sample_revision history (0062) is
-- still written, so the change trail is preserved without keeping stale AI output.
--
-- EDITABILITY GATE — mirrors "before the geologist reviews it":
--   * only the collector (collector_id = p_actor) may edit;
--   * LOCKED once status is 'verified' or 'rejected' (a final review decision);
--   * LOCKED while a reviewer has a draft review open (sample_review.status='draft')
--     so field data can't be pulled out from under an in-progress review.
--   * `needs_more_data` stays EDITABLE on purpose — that is the geologist asking
--     the collector to add data and resubmit.
--
-- Validation mirrors submit_sample (0069): name + GPS + h3 + date + ≥1 context
-- photo + ≥1 close-up. Observations remain optional (AI-first). Service-role only;
-- the enterprise-samples Edge Function authorizes (requireEnterprise) before calling.

create or replace function enterprise.edit_sample(p_actor uuid, p_sample uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = enterprise, geo, extensions, pg_temp
as $$
declare
  v_status enterprise.sample_status;
  v_collector uuid;
  v_name text := btrim(coalesce(p_payload->>'name',''));
  v_lng double precision := nullif(p_payload->>'lng','')::double precision;
  v_lat double precision := nullif(p_payload->>'lat','')::double precision;
  v_pt  extensions.geography;
  v_media_count int := 0;
  v_obs_count int := 0;
  v_context_photos int := 0;
  v_closeup_photos int := 0;
  v_next_rev int;
  o jsonb;
  el jsonb;
begin
  -- ── OWNERSHIP + EDITABILITY GATE ───────────────────────────────────────────
  select status, collector_id into v_status, v_collector
    from enterprise.sample where id = p_sample and deleted_at is null;
  if not found then raise exception 'not_found: sample does not exist'; end if;
  if v_collector is distinct from p_actor then
    raise exception 'forbidden: only the collector can edit this sample'; end if;
  if v_status in ('verified','rejected') then
    raise exception 'locked: a geologist has already reviewed this sample'; end if;
  if exists (select 1 from enterprise.sample_review where sample_id = p_sample and status = 'draft') then
    raise exception 'locked: a reviewer is currently reviewing this sample'; end if;

  -- ── VALIDATION — same required set as submit_sample (0069) ──────────────────
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

  -- ── UPDATE SAMPLE — re-enter the pipeline; clear the stale AI confidence ────
  -- geologist_confidence is NEVER touched here (edits happen pre-review anyway).
  update enterprise.sample set
      name = v_name,
      collected_at = (p_payload->>'collected_at')::timestamptz,
      host_context = nullif(p_payload->>'host_context',''),
      rock_condition = nullif(p_payload->>'rock_condition',''),
      in_situ = (nullif(p_payload->>'in_situ',''))::boolean,
      geological_environment = nullif(p_payload->>'geological_environment',''),
      terrain_type = nullif(p_payload->>'terrain_type','')::terrain_type,
      weather_conditions = nullif(p_payload->>'weather_conditions',''),
      field_observations = nullif(p_payload->>'field_observations',''),
      sample_method = nullif(p_payload->>'sample_method','')::sample_method,
      formation_id = nullif(p_payload->>'formation_id','')::uuid,
      ai_confidence = null,
      status = 'submitted',
      updated_at = now()
    where id = p_sample;

  -- ── REPLACE LOCATION ───────────────────────────────────────────────────────
  delete from enterprise.sample_location where sample_id = p_sample;
  insert into enterprise.sample_location (sample_id, location, altitude_m, gps_accuracy_m, h3_cell, provenance)
  values (p_sample, v_pt, nullif(p_payload->>'altitude_m','')::double precision,
      nullif(p_payload->>'gps_accuracy_m','')::double precision, p_payload->>'h3_cell',
      coalesce(nullif(p_payload->>'gps_source','')::gps_source, 'gps'));

  -- ── REPLACE MEDIA ──────────────────────────────────────────────────────────
  -- The client sends the full desired media list (kept + newly added). Old Storage
  -- objects for removed photos are left in the bucket (harmless orphans in beta).
  delete from enterprise.sample_media where sample_id = p_sample;
  for el in select * from jsonb_array_elements(coalesce(p_payload->'media','[]'::jsonb)) loop
    insert into enterprise.sample_media (sample_id, role, storage_path, thumb_path, width, height, image_quality_score, exif)
    values (p_sample, (el->>'role')::media_role, el->>'storage_path', nullif(el->>'thumb_path',''),
        nullif(el->>'width','')::int, nullif(el->>'height','')::int,
        nullif(el->>'image_quality_score','')::numeric, el->'exif');
    v_media_count := v_media_count + 1;
  end loop;

  -- ── REPLACE FIELD OBSERVATIONS ─────────────────────────────────────────────
  -- These tables only ever hold collector (method='field') rows — the AI writes to
  -- geo.* not here — so replacing the whole set is safe.
  delete from enterprise.rock_observation where sample_id = p_sample;
  delete from enterprise.mineral_observation where sample_id = p_sample;
  delete from enterprise.alteration_observation where sample_id = p_sample;
  delete from enterprise.structural_measurement where sample_id = p_sample;

  o := coalesce(p_payload->'observations', '{}'::jsonb);

  if (o ? 'rock') and (o->'rock' <> 'null'::jsonb)
     and btrim(coalesce(o->'rock'->>'rock_class','')) <> '' then
    insert into enterprise.rock_observation (sample_id, rock_class, host_type, texture, weathering, vein_presence, notes, method)
    values (p_sample, o->'rock'->>'rock_class', nullif(o->'rock'->>'host_type',''), nullif(o->'rock'->>'texture',''),
        nullif(o->'rock'->>'weathering',''), (nullif(o->'rock'->>'vein_presence',''))::boolean,
        nullif(o->'rock'->>'notes',''), 'field');
    v_obs_count := v_obs_count + 1;
  end if;

  for el in select * from jsonb_array_elements(coalesce(o->'minerals','[]'::jsonb)) loop
    if btrim(coalesce(el->>'mineral','')) = '' then continue; end if;
    insert into enterprise.mineral_observation (sample_id, mineral, confidence, method)
    values (p_sample, el->>'mineral', nullif(el->>'confidence','')::numeric, 'field');
    v_obs_count := v_obs_count + 1;
  end loop;

  if (o ? 'alteration') and (o->'alteration' <> 'null'::jsonb)
     and btrim(coalesce(o->'alteration'->>'alteration_type','')) <> '' then
    insert into enterprise.alteration_observation (sample_id, alteration_type, intensity, notes, method)
    values (p_sample, nullif(o->'alteration'->>'alteration_type','')::alteration_type,
        nullif(o->'alteration'->>'intensity','')::alteration_grade, nullif(o->'alteration'->>'notes',''), 'field');
    v_obs_count := v_obs_count + 1;
  end if;

  for el in select * from jsonb_array_elements(coalesce(o->'structural','[]'::jsonb)) loop
    if btrim(coalesce(el->>'structure_type','')) = '' then continue; end if;
    insert into enterprise.structural_measurement (sample_id, structure_type, strike_deg, dip_deg, dip_direction, notes)
    values (p_sample, nullif(el->>'structure_type','')::structure_type, nullif(el->>'strike_deg','')::numeric,
        nullif(el->>'dip_deg','')::numeric, nullif(el->>'dip_direction','')::numeric, nullif(el->>'notes',''));
    v_obs_count := v_obs_count + 1;
  end loop;

  -- ── REPLACE AI ASSESSMENT — keep only the latest (product decision) ─────────
  -- Cascades to conclusions/evidence/edges (0064/0065). The fresh run is kicked
  -- off by the caller (analyze-sample, force) right after this returns.
  delete from geo.geological_assessment where sample_id = p_sample;

  -- ── REVISION SNAPSHOT (append-only history, 0062) ──────────────────────────
  select coalesce(max(revision_no), 0) + 1 into v_next_rev
    from enterprise.sample_revision where sample_id = p_sample;
  insert into enterprise.sample_revision (sample_id, revision_no, edited_by, change_summary, snapshot)
  values (p_sample, v_next_rev, p_actor, 'edited + resubmitted',
      jsonb_build_object('name', v_name, 'lat', v_lat, 'lng', v_lng,
          'collected_at', p_payload->>'collected_at', 'media_count', v_media_count,
          'observation_count', v_obs_count, 'observations', o, 'status', 'submitted'));

  -- ── AUDIT ──────────────────────────────────────────────────────────────────
  insert into enterprise.audit_log (actor_id, action, entity_type, entity_id, after, context)
  values (p_actor, 'update', 'sample', p_sample,
      jsonb_build_object('name', v_name, 'media', v_media_count, 'observations', v_obs_count, 'revision', v_next_rev),
      jsonb_build_object('source','enterprise-samples','edit',true));

  return jsonb_build_object('sample_id', p_sample, 'revision_no', v_next_rev,
      'media_count', v_media_count, 'observation_count', v_obs_count);
end;
$$;

revoke all on function enterprise.edit_sample(uuid, uuid, jsonb) from public;
grant execute on function enterprise.edit_sample(uuid, uuid, jsonb) to service_role;

-- ── VERIFY — expect fn present, execute to service_role only ─────────────────
--   select has_function_privilege('service_role','enterprise.edit_sample(uuid,uuid,jsonb)','execute'); -- t
--   select has_function_privilege('authenticated','enterprise.edit_sample(uuid,uuid,jsonb)','execute'); -- f

-- ── ROLLBACK ──
--   drop function if exists enterprise.edit_sample(uuid, uuid, jsonb);

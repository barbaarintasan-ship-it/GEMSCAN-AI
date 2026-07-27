-- enterprise_submit_sample.integration.sql
--
-- Sprint 4.2 — end-to-end integration verification for the Sample Submission
-- pipeline. Ties the WRITE path (enterprise.submit_sample RPC, migration 0059,
-- called by the enterprise-samples Edge Function with the service role) to the
-- READ path the function relies on (RLS on enterprise.sample & children,
-- migration 0037). Self-asserting: any failed check raises and aborts.
--
-- Run against the local shadow stack (transaction-wrapped; rolls back — leaves
-- no data behind):
--   docker exec -i supabase_db_gemscan-ai psql -U postgres -d postgres \
--     < supabase/tests/enterprise_submit_sample.integration.sql
--
-- Expected tail output: NOTICE "INTEGRATION OK ..." then ROLLBACK.

begin;

-- Two real auth.users (collector_id/created_by/actor_id all FK auth.users).
do $$
declare
  v_owner uuid := '11111111-1111-1111-1111-111111111111';
  v_other uuid := '22222222-2222-2222-2222-222222222222';
  v_res jsonb;
  v_sample uuid;
  v_n int;
  v_geog_ok boolean;
  v_h3 text;
begin
  insert into auth.users (id, instance_id, aud, role, email)
  values (v_owner, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-int@test.local'),
         (v_other, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'other-int@test.local');

  -- ── WRITE: full payload (media x2 + all four observation kinds) ───────────
  v_res := enterprise.submit_sample(v_owner, jsonb_build_object(
    'lat', 2.05, 'lng', 45.32, 'h3_cell', '892a1072003ffff',
    'gps_accuracy_m', 6, 'altitude_m', 12, 'gps_source', 'gps',
    'terrain_type', 'outcrop', 'sample_method', 'rock_chip',
    'field_observations', 'quartz vein in weathered outcrop',
    'media', jsonb_build_array(
      jsonb_build_object('role','context','storage_path','enterprise/owner/ctx.jpg'),
      jsonb_build_object('role','surface_closeup','storage_path','enterprise/owner/close.jpg')),
    'observations', jsonb_build_object(
      'rock', jsonb_build_object('rock_class','granite','texture','coarse','vein_presence',true,'notes','pegmatite'),
      'minerals', jsonb_build_array(
        jsonb_build_object('mineral','quartz','confidence',0.9),
        jsonb_build_object('mineral','feldspar')),
      'alteration', jsonb_build_object('alteration_type','silicification','intensity','moderate','notes','pervasive silica'),
      'structural', jsonb_build_array(
        jsonb_build_object('structure_type','vein','strike_deg',120,'dip_deg',70,'dip_direction',30)))));

  v_sample := (v_res->>'sample_id')::uuid;
  if v_sample is null then raise exception 'submit_sample returned no sample_id'; end if;
  if (v_res->>'media_count')::int <> 2 then raise exception 'expected media_count=2, got %', v_res->>'media_count'; end if;
  if (v_res->>'observation_count')::int <> 5 then raise exception 'expected observation_count=5, got %', v_res->>'observation_count'; end if;

  -- ── Row-level assertions (write persisted correctly) ─────────────────────
  select count(*) into v_n from enterprise.sample where id = v_sample;
  if v_n <> 1 then raise exception 'sample row missing'; end if;

  select count(*) into v_n from enterprise.sample_media where sample_id = v_sample;
  if v_n <> 2 then raise exception 'expected 2 media rows, got %', v_n; end if;

  select count(*) into v_n from enterprise.mineral_observation where sample_id = v_sample;
  if v_n <> 2 then raise exception 'expected 2 mineral rows, got %', v_n; end if;

  select count(*) into v_n from enterprise.rock_observation where sample_id = v_sample;
  if v_n <> 1 then raise exception 'expected 1 rock row, got %', v_n; end if;

  select count(*) into v_n from enterprise.alteration_observation where sample_id = v_sample;
  if v_n <> 1 then raise exception 'expected 1 alteration row, got %', v_n; end if;

  select count(*) into v_n from enterprise.structural_measurement where sample_id = v_sample;
  if v_n <> 1 then raise exception 'expected 1 structural row, got %', v_n; end if;

  -- GPS geography + h3 persisted (PostGIS point built server-side).
  select (location is not null), h3_cell into v_geog_ok, v_h3
    from enterprise.sample_location where sample_id = v_sample;
  if not v_geog_ok then raise exception 'GPS geography not stored'; end if;
  if v_h3 is null then raise exception 'h3_cell not stored'; end if;

  -- Audit ledger appended with the REAL actor.
  select count(*) into v_n from enterprise.audit_log
    where entity_type = 'sample' and entity_id = v_sample and actor_id = v_owner and action = 'insert';
  if v_n <> 1 then raise exception 'expected 1 audit row by owner, got %', v_n; end if;

  raise notice 'WRITE OK — sample % (media=2, obs=5, gps+h3 stored, audit by owner)', v_sample;

  -- ── READ path RLS: exactly what the Edge Function's userClient sees ───────
  -- Owner (collector) must see their own sample; another authenticated user
  -- must NOT (sample_select: collector_id = auth.uid()).
  perform set_config('role', 'authenticated', true);

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  select count(*) into v_n from enterprise.sample where id = v_sample;
  if v_n <> 1 then raise exception 'RLS: owner should read own sample (got %)', v_n; end if;
  -- nested detail (can_read_sample) also visible to the owner
  select count(*) into v_n from enterprise.sample_media where sample_id = v_sample;
  if v_n <> 2 then raise exception 'RLS: owner should read own media (got %)', v_n; end if;
  select count(*) into v_n from enterprise.mineral_observation where sample_id = v_sample;
  if v_n <> 2 then raise exception 'RLS: owner should read own minerals (got %)', v_n; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  select count(*) into v_n from enterprise.sample where id = v_sample;
  if v_n <> 0 then raise exception 'RLS LEAK: other user read a sample they do not own (got %)', v_n; end if;
  select count(*) into v_n from enterprise.sample_media where sample_id = v_sample;
  if v_n <> 0 then raise exception 'RLS LEAK: other user read media (got %)', v_n; end if;

  perform set_config('role', 'postgres', true);  -- restore superuser for the rest of the block
  raise notice 'READ OK — RLS: owner reads own (1); other reads none (0); nested detail scoped';
  raise notice 'INTEGRATION OK — Sprint 4.2 submit_sample write + RLS read path verified end-to-end';
end $$;

rollback;

-- enterprise_recompute_mission_progress.integration.sql
--
-- Phase 2D — end-to-end integration verification for the mission-level
-- progress rollup (enterprise.recompute_mission_progress, migration 0119;
-- enterprise.mission_progress_detail, migration 0120). Ties the recompute
-- RPC to the source-of-truth tables it reads (exploration_mission, sample,
-- the four observation tables, mission_assignment) and to the RLS/
-- authorization boundary (enterprise.is_mission_member) both RPCs share.
-- Self-asserting: any failed check raises and aborts. Same shape as
-- enterprise_submit_sample.integration.sql (0059's own integration test).
--
-- Every scenario in this file was ALSO run live against the production
-- project during Phase 2D implementation via JWT-impersonated SQL (real
-- data, real RLS, no shadow stack) — this file exists so the same
-- guarantees are checkable locally/in CI without touching production.
--
-- Run against the local shadow stack (transaction-wrapped; rolls back —
-- leaves no data behind):
--   docker exec -i supabase_db_gemscan-ai psql -U postgres -d postgres \
--     < supabase/tests/enterprise_recompute_mission_progress.integration.sql
--
-- Expected tail output: NOTICE "INTEGRATION OK ..." then ROLLBACK.

begin;

do $$
declare
  v_manager  uuid := '33333333-3333-3333-3333-333333333333';
  v_worker   uuid := '44444444-4444-4444-4444-444444444444';
  v_outsider uuid := '55555555-5555-5555-5555-555555555555';
  v_project  uuid;
  v_area     uuid;
  v_mission  uuid;
  v_sample_a uuid;
  v_sample_b uuid;
  v_sample_c uuid;
  v_row      enterprise.mission_progress%rowtype;
  v_row2     enterprise.mission_progress%rowtype;
  v_detail   jsonb;
  v_n        int;
  v_failed   boolean;
begin
  insert into auth.users (id, instance_id, aud, role, email) values
    (v_manager,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'p2d-manager@test.local'),
    (v_worker,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'p2d-worker@test.local'),
    (v_outsider, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'p2d-outsider@test.local');

  insert into enterprise.project (name, owner_id, created_by)
    values ('Phase 2D integration project', v_manager, v_manager)
    returning id into v_project;

  insert into enterprise.exploration_area (name, center, project_id, created_by)
    values ('Phase 2D integration area', extensions.st_setsrid(extensions.st_makepoint(45.32, 2.05), 4326)::extensions.geography,
            v_project, v_manager)
    returning id into v_area;

  insert into enterprise.exploration_mission (name, owner_id, project_id, created_by)
    values ('Phase 2D integration mission', v_manager, v_project, v_manager)
    returning id into v_mission;

  insert into enterprise.mission_contributor (mission_id, contributor_id, role) values
    (v_mission, v_manager, 'team_leader'),
    (v_mission, v_worker, 'field_contributor');

  -- ── TEST 1: zero samples ────────────────────────────────────────────────
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_manager, 'role', 'authenticated')::text, true);
  v_row := enterprise.recompute_mission_progress(v_mission);
  if v_row.observation_count <> 0 then raise exception 'TEST 1: expected observation_count=0, got %', v_row.observation_count; end if;
  if v_row.sample_count <> 0 then raise exception 'TEST 1: expected sample_count=0, got %', v_row.sample_count; end if;
  if v_row.coverage_pct <> 0 then raise exception 'TEST 1: expected coverage_pct=0, got %', v_row.coverage_pct; end if;
  raise notice 'TEST 1 OK — zero samples -> 0/0/0';

  perform set_config('role', 'postgres', true);

  -- 3 samples: two collected by v_worker (one with an outside-assignment
  -- flag), one collected by v_manager and then soft-deleted.
  insert into enterprise.sample (id, area_id, mission_id, collector_id, created_by, collected_at, status, outside_assignment, created_at)
    values (gen_random_uuid(), v_area, v_mission, v_worker, v_worker, now(), 'submitted', false, now() - interval '2 hours')
    returning id into v_sample_a;
  insert into enterprise.sample (id, area_id, mission_id, collector_id, created_by, collected_at, status, outside_assignment, created_at)
    values (gen_random_uuid(), v_area, v_mission, v_worker, v_worker, now(), 'submitted', true, now() - interval '1 hour')
    returning id into v_sample_b;
  insert into enterprise.sample (id, area_id, mission_id, collector_id, created_by, collected_at, status, outside_assignment, created_at, deleted_at)
    values (gen_random_uuid(), v_area, v_mission, v_manager, v_manager, now(), 'submitted', null, now(), now())
    returning id into v_sample_c;

  -- Observations on the two live samples: 2 rows on sample_a, 1 on sample_b —
  -- 3 total, across three different observation tables.
  insert into enterprise.rock_observation (sample_id, rock_class) values (v_sample_a, 'granite');
  insert into enterprise.mineral_observation (sample_id, mineral) values (v_sample_a, 'quartz');
  insert into enterprise.structural_measurement (sample_id, structure_type) values (v_sample_b, 'vein');
  -- One observation on the SOFT-DELETED sample — must NOT be counted.
  insert into enterprise.alteration_observation (sample_id, alteration_type) values (v_sample_c, 'silicification');

  -- 10 assigned H3 cells (Phase 2B tables) — deliberately more than the
  -- sample count, so a naive samples/cells ratio would look like 20-40%.
  insert into enterprise.mission_assignment (mission_id, target_h3, contributor_id, status)
    select v_mission, '87' || lpad(to_hex(n), 12, '0') || 'f', v_worker, 'assigned'
    from generate_series(1, 10) as n;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_manager, 'role', 'authenticated')::text, true);
  v_row := enterprise.recompute_mission_progress(v_mission);

  -- ── TEST 2: soft-deleted sample excluded ────────────────────────────────
  if v_row.sample_count <> 2 then raise exception 'TEST 2: expected sample_count=2 (1 soft-deleted excluded), got %', v_row.sample_count; end if;
  raise notice 'TEST 2 OK — 3 samples, 1 soft-deleted -> sample_count=2';

  -- ── TEST 3: assigned cells vs samples never produces a fake coverage % ──
  select count(*) into v_n from enterprise.mission_assignment where mission_id = v_mission;
  if v_n <> 10 then raise exception 'TEST 3: expected 10 assigned cells, got %', v_n; end if;
  if v_row.sample_count <> 2 then raise exception 'TEST 3: expected sample_count=2, got %', v_row.sample_count; end if;
  if v_row.coverage_pct <> 0 then raise exception 'TEST 3: coverage_pct must stay 0 (got %) -- cell-level mapping is not implemented', v_row.coverage_pct; end if;
  raise notice 'TEST 3 OK — 10 assigned cells, 2 live samples, coverage_pct stayed 0 (not 20%%)';

  -- ── observation_count: four-table semantic, not a sample count ─────────
  if v_row.observation_count <> 3 then raise exception 'TEST: expected observation_count=3 (2 on sample_a + 1 on sample_b, sample_c excluded), got %', v_row.observation_count; end if;
  raise notice 'observation_count OK — 3 structured-observation rows across live samples, deleted-sample row excluded';

  -- ── TEST 4 + per-contributor detail ─────────────────────────────────────
  v_detail := enterprise.mission_progress_detail(v_mission);
  if jsonb_array_length(v_detail->'per_contributor') <> 1 then
    raise exception 'TEST 4: expected exactly 1 contributor with samples (v_worker), got %', jsonb_array_length(v_detail->'per_contributor');
  end if;
  if (v_detail->'per_contributor'->0->>'contributor_id')::uuid <> v_worker then
    raise exception 'TEST 4: expected contributor_id=%, got %', v_worker, v_detail->'per_contributor'->0->>'contributor_id';
  end if;
  if (v_detail->'per_contributor'->0->>'sample_count')::int <> 2 then
    raise exception 'TEST 4: expected worker sample_count=2, got %', v_detail->'per_contributor'->0->>'sample_count';
  end if;
  raise notice 'TEST 4 OK — per-contributor breakdown: worker=2 samples, manager''s soft-deleted sample excluded';

  -- ── TEST 5: outside_assignment sample still counted ─────────────────────
  if (v_detail->>'outside_assignment_count')::int <> 1 then
    raise exception 'TEST 5: expected outside_assignment_count=1, got %', v_detail->>'outside_assignment_count';
  end if;
  if v_row.sample_count <> 2 then raise exception 'TEST 5: outside-assignment sample must remain in sample_count'; end if;
  raise notice 'TEST 5 OK — outside-assignment sample counted as real evidence, not excluded';

  -- ── TEST 6: last_activity = max(non-deleted sample.created_at) ──────────
  if (v_detail->>'last_activity_at')::timestamptz <> (select max(created_at) from enterprise.sample where mission_id = v_mission and deleted_at is null) then
    raise exception 'TEST 6: last_activity_at does not match max(created_at) over live samples';
  end if;
  raise notice 'TEST 6 OK — last_activity_at matches max(created_at) of non-deleted samples';

  -- ── TEST 7: unauthorized caller rejected ─────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_outsider, 'role', 'authenticated')::text, true);
  v_failed := false;
  begin
    perform enterprise.recompute_mission_progress(v_mission);
  exception when others then
    v_failed := true;
  end;
  if not v_failed then raise exception 'TEST 7: an outsider was able to recompute another mission''s progress'; end if;

  v_failed := false;
  begin
    perform enterprise.mission_progress_detail(v_mission);
  exception when others then
    v_failed := true;
  end;
  if not v_failed then raise exception 'TEST 7: an outsider was able to read another mission''s progress detail'; end if;
  raise notice 'TEST 7 OK — non-member rejected on both recompute and detail';

  -- ── TEST 8: idempotency ──────────────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_manager, 'role', 'authenticated')::text, true);
  v_row2 := enterprise.recompute_mission_progress(v_mission);
  if v_row2.observation_count <> v_row.observation_count
     or v_row2.sample_count <> v_row.sample_count
     or v_row2.coverage_pct <> v_row.coverage_pct then
    raise exception 'TEST 8: recompute is not idempotent -- values changed between calls with unchanged source data';
  end if;
  raise notice 'TEST 8 OK — identical values across two consecutive calls with unchanged source data';

  perform set_config('role', 'postgres', true);
  raise notice 'INTEGRATION OK — Phase 2D mission-level progress rollup verified end-to-end (tests 1-8; test 9 (Solo-exploration non-interference) is a static/Jest check, not a database one)';
end $$;

rollback;

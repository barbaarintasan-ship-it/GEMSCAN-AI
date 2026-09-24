-- 0147_compare_mission_areas_rpc.sql
--
-- Phase 12 (Geological Intelligence Transformation) — "Why A > B" comparative
-- reasoning between two areas in the same mission. PURELY DETERMINISTIC: reads
-- the SAME prospectivity_score/reasons/coverage/evidence Phase 10 already
-- persisted on mission_assignment, never recomputes them, and involves no AI
-- call — this is not a second scoring engine, it is a read-only diff over
-- numbers the engine already produced. Matches the architecture invariant
-- every prior phase has kept: the deterministic engine is authoritative for
-- score/evidence, and nothing here overrides or blends it.
--
-- AUTHORIZATION: is_mission_member(p_mission) — viewing a comparison is a
-- read, not a write, so the broader membership boundary applies (same as
-- area_select/mission_area RLS), not the stricter is_mission_manager used by
-- review_area/create_mission_area_from_target for MUTATIONS.
--
-- "Best cell" per area = the canonical (contributor_id is null) cell with the
-- highest prospectivity_score within that area — the same row
-- fetchAreaReviewDetail already surfaces to a reviewer, so the comparison
-- screen and the review screen never disagree about which cell represents
-- an area.

create or replace function enterprise.compare_mission_areas(
  p_mission uuid,
  p_area_a uuid,
  p_area_b uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = enterprise, pg_temp
as $$
declare
  v_a jsonb;
  v_b jsonb;
  v_roles_a text[];
  v_roles_b text[];
  v_kinds_a text[];
  v_kinds_b text[];
begin
  if not enterprise.is_mission_member(p_mission) then
    raise exception 'forbidden: only a member of this mission can compare its areas';
  end if;

  if not exists (select 1 from enterprise.mission_area where mission_id = p_mission and area_id = p_area_a) then
    raise exception 'validation: area % does not belong to mission %', p_area_a, p_mission;
  end if;
  if not exists (select 1 from enterprise.mission_area where mission_id = p_mission and area_id = p_area_b) then
    raise exception 'validation: area % does not belong to mission %', p_area_b, p_mission;
  end if;

  select jsonb_build_object(
    'area_id', ea.id, 'name', ea.name, 'review_status', ea.review_status,
    'target_h3', ma.target_h3, 'score', ma.prospectivity_score,
    'integrated_score', ma.integrated_score, 'reasons', ma.reasons, 'coverage', ma.coverage
  ) into v_a
  from enterprise.exploration_area ea
  left join lateral (
    select target_h3, prospectivity_score, integrated_score, reasons, coverage
    from enterprise.mission_assignment
    where mission_id = p_mission and area_id = p_area_a and contributor_id is null
    order by prospectivity_score desc nulls last
    limit 1
  ) ma on true
  where ea.id = p_area_a;

  select jsonb_build_object(
    'area_id', ea.id, 'name', ea.name, 'review_status', ea.review_status,
    'target_h3', ma.target_h3, 'score', ma.prospectivity_score,
    'integrated_score', ma.integrated_score, 'reasons', ma.reasons, 'coverage', ma.coverage
  ) into v_b
  from enterprise.exploration_area ea
  left join lateral (
    select target_h3, prospectivity_score, integrated_score, reasons, coverage
    from enterprise.mission_assignment
    where mission_id = p_mission and area_id = p_area_b and contributor_id is null
    order by prospectivity_score desc nulls last
    limit 1
  ) ma on true
  where ea.id = p_area_b;

  -- Coverage-role diff: roles marked 'present' in A's coverage but not
  -- 'present' in B's (and vice versa) — the honest "what evidence one area
  -- has that the other doesn't", not a probability comparison.
  select array_agg(r->>'role') into v_roles_a
    from jsonb_array_elements(coalesce(v_a->'coverage'->'roles', '[]'::jsonb)) r
    where r->>'state' = 'present';
  select array_agg(r->>'role') into v_roles_b
    from jsonb_array_elements(coalesce(v_b->'coverage'->'roles', '[]'::jsonb)) r
    where r->>'state' = 'present';

  -- Reason-kind diff: the kinds of evidence (occurrence/fault/contact/...)
  -- driving each area's reasons, by set difference — never a re-derived score.
  select array_agg(distinct r->>'kind') into v_kinds_a
    from jsonb_array_elements(coalesce(v_a->'reasons', '[]'::jsonb)) r;
  select array_agg(distinct r->>'kind') into v_kinds_b
    from jsonb_array_elements(coalesce(v_b->'reasons', '[]'::jsonb)) r;

  return jsonb_build_object(
    'area_a', v_a,
    'area_b', v_b,
    'diff', jsonb_build_object(
      'score_delta', case when (v_a->>'score') is not null and (v_b->>'score') is not null
        then (v_a->>'score')::numeric - (v_b->>'score')::numeric else null end,
      'roles_only_in_a', to_jsonb(coalesce(array(select unnest(coalesce(v_roles_a, '{}')) except select unnest(coalesce(v_roles_b, '{}'))), '{}')),
      'roles_only_in_b', to_jsonb(coalesce(array(select unnest(coalesce(v_roles_b, '{}')) except select unnest(coalesce(v_roles_a, '{}'))), '{}')),
      'reason_kinds_only_in_a', to_jsonb(coalesce(array(select unnest(coalesce(v_kinds_a, '{}')) except select unnest(coalesce(v_kinds_b, '{}'))), '{}')),
      'reason_kinds_only_in_b', to_jsonb(coalesce(array(select unnest(coalesce(v_kinds_b, '{}')) except select unnest(coalesce(v_kinds_a, '{}'))), '{}'))
    )
  );
end;
$$;
grant execute on function enterprise.compare_mission_areas(uuid, uuid, uuid) to authenticated;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select has_function_privilege('authenticated', 'enterprise.compare_mission_areas(uuid,uuid,uuid)', 'execute');

-- ── ROLLBACK (down-path) ────────────────────────────────────────────────────
--   drop function if exists enterprise.compare_mission_areas(uuid, uuid, uuid);

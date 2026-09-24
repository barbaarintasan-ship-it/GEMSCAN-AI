-- 0157_compare_mission_areas_null_reasons_fix.sql
--
-- Real production bug, found via device smoke test (2026-09-24): comparing
-- an area whose best cell predates Phase 10's evidence-graph persistence
-- (reasons/coverage genuinely SQL NULL — a real, valid state, not a
-- fabricated default) threw "cannot extract elements from a scalar".
--
-- Root cause: jsonb_build_object('reasons', ma.reasons, ...) turns a SQL
-- NULL column value into a JSON `null` SCALAR stored under that key — not
-- an absent key, and not SQL NULL itself. coalesce(v_a->'reasons',
-- '[]'::jsonb) only replaces actual SQL NULL, so it never catches this, and
-- jsonb_array_elements('null'::jsonb) throws (JSON null is a scalar to
-- Postgres, not an empty array). nullif(x, 'null'::jsonb) converts that
-- specific jsonb-null value back into a real SQL NULL first, so coalesce
-- can do its job.

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

  select array_agg(r->>'role') into v_roles_a
    from jsonb_array_elements(coalesce(nullif(v_a->'coverage'->'roles', 'null'::jsonb), '[]'::jsonb)) r
    where r->>'state' = 'present';
  select array_agg(r->>'role') into v_roles_b
    from jsonb_array_elements(coalesce(nullif(v_b->'coverage'->'roles', 'null'::jsonb), '[]'::jsonb)) r
    where r->>'state' = 'present';

  select array_agg(distinct r->>'kind') into v_kinds_a
    from jsonb_array_elements(coalesce(nullif(v_a->'reasons', 'null'::jsonb), '[]'::jsonb)) r;
  select array_agg(distinct r->>'kind') into v_kinds_b
    from jsonb_array_elements(coalesce(nullif(v_b->'reasons', 'null'::jsonb), '[]'::jsonb)) r;

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

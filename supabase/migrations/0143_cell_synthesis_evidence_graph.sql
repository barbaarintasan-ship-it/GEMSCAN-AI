-- 0143_cell_synthesis_evidence_graph.sql
--
-- Phase 10.4 (Geological Intelligence Transformation) — cross-contributor
-- cell synthesis (Phase 7) currently tells Claude the deterministic score
-- itself, but not WHY the engine landed there: no mapped occurrences, no
-- fault distance, no note that lithology/terrain are simply unavailable
-- here. Without that, Claude cannot tell "contributors disagree because the
-- ground is genuinely ambiguous" from "contributors disagree, and neither
-- one is anywhere near what the engine already found" (an occurrence 200m
-- away that nobody's sample mentions, say).
--
-- reasons/coverage were already persisted onto mission_assignment by 0142
-- (Phase 10.1/10.2) — this migration only reads them into the context this
-- function already builds. No new computation, same "no score field" AI-
-- safety shape as 0130/0131: reasons/coverage are read-only grounding, never
-- a value Claude is asked to reproduce or extend.

create or replace function enterprise.get_cell_synthesis_context(p_mission uuid, p_target_h3 text)
returns jsonb
language plpgsql
stable
security definer
set search_path = enterprise, pg_temp
as $$
declare
  v_result jsonb;
  v_score numeric;
  v_score_version text;
  v_reasons jsonb;
  v_coverage jsonb;
  v_contributor_count int;
  v_sample_count int;
begin
  if not enterprise.is_mission_manager(p_mission) then
    raise exception 'forbidden: only a mission manager can request cross-contributor synthesis';
  end if;

  select ma.prospectivity_score, ma.score_engine_version, ma.reasons, ma.coverage
    into v_score, v_score_version, v_reasons, v_coverage
    from enterprise.mission_assignment ma
    where ma.mission_id = p_mission and ma.target_h3 = p_target_h3 and ma.contributor_id is null
    limit 1;

  select count(distinct s.collector_id), count(*)
    into v_contributor_count, v_sample_count
    from enterprise.sample s
    where s.mission_id = p_mission and s.assignment_h3 = p_target_h3 and s.deleted_at is null;

  select jsonb_build_object(
    'mission_id', p_mission,
    'target_h3', p_target_h3,
    'deterministic_score', v_score,
    'score_engine_version', v_score_version,
    'reasons', v_reasons,
    'coverage', v_coverage,
    'contributor_count', coalesce(v_contributor_count, 0),
    'sample_count', coalesce(v_sample_count, 0),
    'contributors', coalesce((
      select jsonb_agg(row_data order by row_data->>'contributor_label', row_data->>'collected_at')
      from (
        select jsonb_build_object(
          'contributor_label', 'Contributor ' || chr(65 + (dense_rank() over (order by s.collector_id) - 1)::int),
          'sample_id', s.id,
          'collected_at', s.collected_at,
          'host_context', s.host_context,
          'geological_environment', s.geological_environment,
          'field_observations', s.field_observations,
          'rock_class', ro.rock_class,
          'minerals', coalesce((select jsonb_agg(mo.mineral) from enterprise.mineral_observation mo where mo.sample_id = s.id), '[]'::jsonb),
          'structured_evidence', coalesce((
            select jsonb_agg(jsonb_build_object(
              'evidence_type', se.evidence_type,
              'payload', se.payload,
              'verification_status', se.verification_status
            ))
            from enterprise.sample_structured_evidence se
            where se.sample_id = s.id
          ), '[]'::jsonb)
        ) as row_data
        from enterprise.sample s
        left join enterprise.rock_observation ro on ro.sample_id = s.id
        where s.mission_id = p_mission and s.assignment_h3 = p_target_h3 and s.deleted_at is null
      ) rows
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;
grant execute on function enterprise.get_cell_synthesis_context(uuid, text) to authenticated;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   A cell scored since migration 0142 must return non-null reasons/coverage;
--   a cell scored before it (or never scored) returns null for both, exactly
--   like deterministic_score already does today — never a fabricated default.

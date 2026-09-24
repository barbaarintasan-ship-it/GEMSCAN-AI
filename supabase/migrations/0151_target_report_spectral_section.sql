-- 0151_target_report_spectral_section.sql
--
-- Phase 16 — adds a `spectral` section to get_target_report (0149), reading
-- the most recent enterprise.area_spectral_index (0150) row for the area, if
-- any. Purely additive: every existing key is untouched; `spectral` is null
-- when no spectral index has ever been computed for this area — never a
-- fabricated zero. Still NOT part of `target.score`/`target.reasons` — a
-- human reads this section, the deterministic engine never does.

create or replace function enterprise.get_target_report(
  p_mission uuid,
  p_area uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = enterprise, pg_temp
as $$
declare
  v_area jsonb;
  v_cell jsonb;
  v_target_h3 text;
  v_synthesis jsonb;
  v_spectral jsonb;
begin
  if not enterprise.is_mission_member(p_mission) then
    raise exception 'forbidden: only a member of this mission can view its target report';
  end if;

  if not exists (select 1 from enterprise.mission_area where mission_id = p_mission and area_id = p_area) then
    raise exception 'validation: area % does not belong to mission %', p_area, p_mission;
  end if;

  select jsonb_build_object(
    'area_id', ea.id, 'name', ea.name, 'review_status', ea.review_status,
    'reviewed_by', ea.reviewed_by, 'reviewed_at', ea.reviewed_at, 'review_notes', ea.review_notes,
    'reviewer_role', ea.reviewer_role,
    'source_target_h3', ea.source_target_h3, 'source_target_score', ea.source_target_score,
    'source_commodity', ea.source_commodity, 'created_at', ea.created_at
  ) into v_area
  from enterprise.exploration_area ea
  where ea.id = p_area;

  select jsonb_build_object(
    'target_h3', ma.target_h3, 'score', ma.prospectivity_score, 'scored_at', ma.scored_at,
    'integrated_score', ma.integrated_score, 'evidence_sample_count', ma.evidence_sample_count,
    'reasons', ma.reasons, 'coverage', ma.coverage, 'evidence', ma.evidence
  ), ma.target_h3 into v_cell, v_target_h3
  from enterprise.mission_assignment ma
  where ma.mission_id = p_mission and ma.area_id = p_area and ma.contributor_id is null
  order by ma.prospectivity_score desc nulls last
  limit 1;

  if v_target_h3 is not null then
    select jsonb_build_object(
      'headline', cs.headline, 'headline_so', cs.headline_so,
      'narrative', cs.narrative, 'narrative_so', cs.narrative_so,
      'agreement', cs.agreement, 'contributor_count', cs.contributor_count,
      'sample_count', cs.sample_count, 'generated_at', cs.created_at
    ) into v_synthesis
    from enterprise.cell_synthesis cs
    where cs.mission_id = p_mission and cs.target_h3 = v_target_h3;
  end if;

  select jsonb_build_object(
    'index_name', si.index_name, 'value', si.value, 'acquisition_date', si.acquisition_date,
    'cloud_fraction', si.cloud_fraction, 'valid_pixel_fraction', si.valid_pixel_fraction,
    'resolution_m', si.resolution_m, 'source', si.source, 'computed_at', si.computed_at
  ) into v_spectral
  from enterprise.area_spectral_index si
  where si.area_id = p_area
  order by si.acquisition_date desc
  limit 1;

  return jsonb_build_object(
    'mission_id', p_mission,
    'area', v_area,
    'target', coalesce(v_cell, jsonb_build_object('note', 'no scored cell exists in this area yet')),
    'ai_synthesis', v_synthesis,
    'spectral', v_spectral
  );
end;
$$;
grant execute on function enterprise.get_target_report(uuid, uuid) to authenticated;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select has_function_privilege('authenticated', 'enterprise.get_target_report(uuid,uuid)', 'execute');

-- 0133_mission_assignment_integrated_score.sql
--
-- Phase 8 — the Integrated Prospectivity Score for a Team cell. Baseline
-- prospectivity_score (Phase 3) is computed with NO local evidence and stays
-- that way, exactly like Solo's validated ranking baseline (LOO AUC 0.900) —
-- see teamIntegratedEvidence.ts's own header note for the invariant this
-- respects. integrated_score is a SEPARATE, informational number: the
-- baseline combined with whatever structured evidence (0128) contributors
-- have collected in that cell, via the same noisy-OR arithmetic Solo's own
-- client-side "so-far" integrated score uses. NULL until evidence exists —
-- an unscored cell must never look identical to "evidence confirmed nothing
-- new".

alter table enterprise.mission_assignment
  add column if not exists integrated_score numeric,
  add column if not exists integrated_scored_at timestamptz,
  add column if not exists evidence_sample_count int;

comment on column enterprise.mission_assignment.integrated_score is
  'Phase 8 — prospectivity_score combined with locally collected structured evidence (enterprise.sample_structured_evidence) for this cell. NULL until at least one sample in the cell has structured evidence. Never replaces prospectivity_score, which stays the validated baseline used for ranking/sort.';
comment on column enterprise.mission_assignment.evidence_sample_count is
  'How many distinct samples contributed to integrated_score the last time it was computed.';

create or replace function enterprise.score_mission_cells(p_mission uuid, p_scores jsonb)
returns integer
language plpgsql
security definer
set search_path = enterprise, pg_temp
as $$
declare
  v_updated integer;
  v_requested integer;
begin
  if not enterprise.is_mission_manager(p_mission) then
    raise exception 'forbidden: only the mission owner or an org owner/admin can score cells';
  end if;

  v_requested := coalesce(jsonb_array_length(p_scores), 0);
  if v_requested = 0 then
    raise exception 'validation: no scores supplied';
  end if;

  with input as (
    select
      elem->>'target_h3' as target_h3,
      (elem->>'score')::numeric as score,
      nullif(elem->>'engine_version', '') as engine_version,
      (elem->>'integrated_score')::numeric as integrated_score,
      (elem->>'evidence_sample_count')::int as evidence_sample_count
    from jsonb_array_elements(p_scores) as elem
  ),
  validated as (
    select * from input
    where target_h3 ~ '^[0-9a-f]{15}$'
      and score is not null and score >= 0 and score <= 1
      and (integrated_score is null or (integrated_score >= 0 and integrated_score <= 1))
  ),
  upd as (
    update enterprise.mission_assignment ma
      set prospectivity_score = v.score,
          scored_at = now(),
          score_engine_version = v.engine_version,
          integrated_score = v.integrated_score,
          integrated_scored_at = case when v.integrated_score is not null then now() else ma.integrated_scored_at end,
          evidence_sample_count = coalesce(v.evidence_sample_count, 0)
    from validated v
    where ma.mission_id = p_mission and ma.target_h3 = v.target_h3
      and ma.contributor_id is null
    returning ma.id
  )
  select count(*) into v_updated from upd;

  insert into enterprise.audit_log (actor_id, action, entity_type, entity_id, after, context)
  values (auth.uid(), 'mission_score_cells', 'exploration_mission', p_mission,
    jsonb_build_object('requested', v_requested, 'updated', v_updated),
    jsonb_build_object('source', 'enterprise.score_mission_cells'));

  return v_updated;
end;
$$;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select column_name from information_schema.columns where table_schema='enterprise' and table_name='mission_assignment' and column_name like 'integrated%';

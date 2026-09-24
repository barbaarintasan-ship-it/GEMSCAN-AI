-- 0142_mission_assignment_evidence_graph.sql
--
-- Phase 10.1/10.2 (Geological Intelligence Transformation) — Team/Solo
-- evidence parity, part 1: persist the evidence graph and data-completeness
-- coverage that TargetingEngine.targetAt() ALREADY computes on every score
-- (ExplorationTarget.evidence / .reasons / .coverage), but that
-- score-mission-cells previously discarded after building the HTTP response.
-- Solo has had this durably (assessment_conclusion/evidence/edge, per
-- sample) since Phase 1; Team never persisted the cell-level equivalent —
-- so "why is this cell 0.72" could only be answered by re-running scoring.
--
-- No new algorithm: `evidence`/`reasons`/`coverage` are plain JSON-safe
-- structures the engine was already returning; this migration only adds
-- somewhere to put them.

alter table enterprise.mission_assignment
  add column if not exists evidence jsonb,
  add column if not exists reasons jsonb,
  add column if not exists coverage jsonb;

comment on column enterprise.mission_assignment.evidence is
  'Phase 10 — the raw Scored[] (ExplorationTarget.evidence) the last scoring run produced for this cell: every {item:{statement,weight,tier}, reason, role, group} the deterministic engine found. The traceable "why" behind prospectivity_score, without re-running scoring.';
comment on column enterprise.mission_assignment.reasons is
  'Phase 10 — ExplorationTarget.reasons: the curated, UI-facing TargetReason[] (occurrence/fault/contact/intersection/unit/... with distances) — the same shape team-targeting already returns for AI-recommended targets, now persisted for scored mission cells too.';
comment on column enterprise.mission_assignment.coverage is
  'Phase 10 — ExplorationTarget.coverage (EvidenceCoverage): per-role state (present/not_scored/none_here/empty_layer/no_source). Lets a manager distinguish "this cell scored low because the ground is unfavourable" from "this cell scored low because we have no data here" — the exact distinction the product spec calls for.';

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
      (elem->>'evidence_sample_count')::int as evidence_sample_count,
      elem->'evidence' as evidence,
      elem->'reasons' as reasons,
      elem->'coverage' as coverage
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
          evidence_sample_count = coalesce(v.evidence_sample_count, 0),
          evidence = v.evidence,
          reasons = v.reasons,
          coverage = v.coverage
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
--   select column_name from information_schema.columns where table_schema='enterprise' and table_name='mission_assignment' and column_name in ('evidence','reasons','coverage');

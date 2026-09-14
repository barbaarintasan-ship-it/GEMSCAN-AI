-- 0130_cell_synthesis.sql
--
-- Phase 7 — Team Claude cross-evidence synthesis. When a mission cell
-- (target_h3) has been worked by more than one contributor, a manager can
-- ask Claude to read across everyone's samples/structured evidence and
-- narrate where they agree, where they conflict, and what that means —
-- exactly the kind of judgment call a human lead would otherwise have to
-- make by opening every sample individually.
--
-- Same AI-safety firewall as Solo's own mission analysis (missionPrompt.ts):
-- Claude only narrates. The deterministic score lives in
-- mission_assignment.prospectivity_score (Phase 3/8) and is never touched
-- here — this table has NO numeric score/confidence column by design, so
-- there is nothing for a hallucinated number to overwrite even if the
-- edge function's own filtering were ever bypassed.

create table enterprise.cell_synthesis (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null references enterprise.exploration_mission(id) on delete cascade,
  target_h3 text not null,
  contributor_count int not null,
  sample_count int not null,
  agreement text not null check (agreement in ('consistent', 'mixed', 'conflicting', 'insufficient_data')),
  headline text not null,
  headline_so text,
  narrative text not null,
  narrative_so text,
  model text not null,
  generated_by uuid not null,
  created_at timestamptz not null default now(),
  unique (mission_id, target_h3)
);

comment on table enterprise.cell_synthesis is
  'Team Phase 7 — Claude-generated narrative comparing multiple contributors'' evidence for one mission cell. Narrative only, no score field: the authoritative score stays in mission_assignment.prospectivity_score.';

alter table enterprise.cell_synthesis enable row level security;

create policy cell_synthesis_select on enterprise.cell_synthesis
  for select using (enterprise.is_mission_member(mission_id));

-- No insert/update/delete policies — all writes go through
-- save_cell_synthesis() below, which re-checks authorization itself.

create index idx_cell_synthesis_mission on enterprise.cell_synthesis (mission_id);

-- Gathers everything the edge function needs to build a synthesis prompt.
-- Contributors are labeled "Contributor A/B/..." rather than by name/id —
-- the synthesis compares accounts, it doesn't need identities.
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
begin
  if not enterprise.is_mission_manager(p_mission) then
    raise exception 'forbidden: only a mission manager can request cross-contributor synthesis';
  end if;

  select ma.prospectivity_score, ma.score_engine_version
    into v_score, v_score_version
    from enterprise.mission_assignment ma
    where ma.mission_id = p_mission and ma.target_h3 = p_target_h3 and ma.contributor_id is null
    limit 1;

  select jsonb_build_object(
    'mission_id', p_mission,
    'target_h3', p_target_h3,
    'deterministic_score', v_score,
    'score_engine_version', v_score_version,
    'contributors', coalesce((
      select jsonb_agg(jsonb_build_object(
        'contributor_label', 'Contributor ' || chr(65 + ((row_number() over (order by s.collector_id, s.id)) - 1)::int),
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
      ))
      from enterprise.sample s
      left join enterprise.rock_observation ro on ro.sample_id = s.id
      where s.mission_id = p_mission and s.assignment_h3 = p_target_h3 and s.deleted_at is null
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;
grant execute on function enterprise.get_cell_synthesis_context(uuid, text) to authenticated;

-- Stores the edge function's synthesis result. Re-checks authorization
-- (never trusts that only an authorized caller could have reached this far)
-- and rejects any agreement value outside the fixed vocabulary.
create or replace function enterprise.save_cell_synthesis(
  p_mission uuid,
  p_target_h3 text,
  p_contributor_count int,
  p_sample_count int,
  p_agreement text,
  p_headline text,
  p_headline_so text,
  p_narrative text,
  p_narrative_so text,
  p_model text
)
returns uuid
language plpgsql
security definer
set search_path = enterprise, pg_temp
as $$
declare
  v_id uuid;
begin
  if not enterprise.is_mission_manager(p_mission) then
    raise exception 'forbidden: only a mission manager can save cross-contributor synthesis';
  end if;
  if p_agreement not in ('consistent', 'mixed', 'conflicting', 'insufficient_data') then
    raise exception 'validation: invalid agreement value';
  end if;
  if p_headline is null or p_narrative is null then
    raise exception 'validation: headline and narrative are required';
  end if;

  insert into enterprise.cell_synthesis
    (mission_id, target_h3, contributor_count, sample_count, agreement, headline, headline_so, narrative, narrative_so, model, generated_by)
  values (p_mission, p_target_h3, p_contributor_count, p_sample_count, p_agreement, p_headline, p_headline_so, p_narrative, p_narrative_so, p_model, auth.uid())
  on conflict (mission_id, target_h3) do update set
    contributor_count = excluded.contributor_count,
    sample_count = excluded.sample_count,
    agreement = excluded.agreement,
    headline = excluded.headline,
    headline_so = excluded.headline_so,
    narrative = excluded.narrative,
    narrative_so = excluded.narrative_so,
    model = excluded.model,
    generated_by = excluded.generated_by,
    created_at = now()
  returning id into v_id;

  insert into enterprise.audit_log (actor_id, action, entity_type, entity_id, after, context)
  values (auth.uid(), 'upsert', 'cell_synthesis', v_id,
    jsonb_build_object('mission_id', p_mission, 'target_h3', p_target_h3, 'agreement', p_agreement),
    jsonb_build_object('source', 'enterprise.save_cell_synthesis'));

  return v_id;
end;
$$;
grant execute on function enterprise.save_cell_synthesis(uuid, text, int, int, text, text, text, text, text, text) to authenticated;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select count(*) from information_schema.tables where table_schema='enterprise' and table_name='cell_synthesis';
--   select has_function_privilege('authenticated', 'enterprise.get_cell_synthesis_context(uuid,text)', 'execute');
--   select has_function_privilege('authenticated', 'enterprise.save_cell_synthesis(uuid,text,int,int,text,text,text,text,text,text)', 'execute');

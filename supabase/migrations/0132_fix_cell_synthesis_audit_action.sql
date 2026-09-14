-- 0132_fix_cell_synthesis_audit_action.sql
--
-- save_cell_synthesis (0130) logged action='upsert', which is not a value of
-- enterprise.audit_action (caught during live verification before any real
-- traffic hit this path). Uses 'insert' — accurate for both the first write
-- and a later regeneration, and avoids adding a new enum value for what is
-- only an audit-log label.

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
  values (auth.uid(), 'insert', 'cell_synthesis', v_id,
    jsonb_build_object('mission_id', p_mission, 'target_h3', p_target_h3, 'agreement', p_agreement),
    jsonb_build_object('source', 'enterprise.save_cell_synthesis'));

  return v_id;
end;
$$;
grant execute on function enterprise.save_cell_synthesis(uuid, text, int, int, text, text, text, text, text, text) to authenticated;

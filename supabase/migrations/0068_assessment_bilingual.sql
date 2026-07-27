-- 0068_assessment_bilingual.sql
--
-- Corrective, IDEMPOTENT migration for bilingual (en + so) assessment output.
-- The Somali columns + bilingual save_assessment were added by editing 0065/0066
-- AFTER those migrations had already been applied to the remote — and applied
-- migrations never re-run, so the remote is missing them. This migration adds
-- them safely (add-column-if-not-exists + create-or-replace), so it is a no-op on
-- any database that already has the bilingual schema and a fix on the one that
-- doesn't.

alter table geo.assessment_conclusion add column if not exists statement_so text;
alter table geo.assessment_evidence   add column if not exists statement_so text;

create or replace function geo.save_assessment(p_sample uuid, p_actor uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = geo, enterprise, pg_temp
as $$
declare
  v_assessment uuid;
  v_existing uuid;
  v_overall numeric := nullif(p_payload->>'overallConfidence','')::numeric;
  v_ev_map jsonb := '{}'::jsonb;      -- { "e1": "<uuid>", ... }
  v_concl uuid;
  v_ev_uuid uuid;
  el jsonb; ed jsonb;
begin
  if (p_payload->>'inputHash') is not null then
    select id into v_existing from geo.geological_assessment
      where sample_id = p_sample and input_hash = p_payload->>'inputHash' limit 1;
    if v_existing is not null then
      return jsonb_build_object('assessment_id', v_existing, 'idempotent', true);
    end if;
  end if;

  insert into geo.geological_assessment
    (sample_id, engine_version, model, input_hash, status, overall_confidence, report)
  values (p_sample, coalesce(p_payload->>'engineVersion','gie-1.0.0'), p_payload->>'model',
    p_payload->>'inputHash', 'ai_completed', v_overall, coalesce(p_payload->'report','{}'::jsonb))
  returning id into v_assessment;

  for el in select * from jsonb_array_elements(coalesce(p_payload->'evidence','[]'::jsonb)) loop
    insert into geo.assessment_evidence
      (assessment_id, source, ev_type, statement, statement_so, is_observation, tier, quality, dataset_id, provenance)
    values (v_assessment, el->>'source', el->>'evType', el->>'statement', el->>'statementSo',
      coalesce((el->>'isObservation')::boolean, false), nullif(el->>'tier',''),
      nullif(el->>'quality','')::numeric, nullif(el->>'datasetId','')::uuid, el->'provenance')
    returning id into v_ev_uuid;
    v_ev_map := v_ev_map || jsonb_build_object(el->>'id', v_ev_uuid::text);
  end loop;

  for el in select * from jsonb_array_elements(coalesce(p_payload->'conclusions','[]'::jsonb)) loop
    insert into geo.assessment_conclusion
      (assessment_id, kind, statement, statement_so, is_interpretation, confidence)
    values (v_assessment, el->>'kind', el->>'statement', el->>'statementSo',
      coalesce((el->>'isInterpretation')::boolean, true), nullif(el->>'confidence','')::numeric)
    returning id into v_concl;

    for ed in select * from jsonb_array_elements(coalesce(el->'edges','[]'::jsonb)) loop
      v_ev_uuid := nullif(v_ev_map->>(ed->>'evidenceId'), '')::uuid;
      if v_ev_uuid is null then continue; end if;
      insert into geo.assessment_edge
        (assessment_id, conclusion_id, evidence_id, polarity, contribution, effective_weight)
      values (v_assessment, v_concl, v_ev_uuid, coalesce(nullif(ed->>'polarity',''),'supporting'),
        nullif(ed->>'contribution','')::numeric, nullif(ed->>'effectiveWeight','')::numeric);
    end loop;
  end loop;

  update enterprise.sample
    set ai_confidence = v_overall, status = 'awaiting_review', updated_at = now()
    where id = p_sample;

  insert into enterprise.audit_log (actor_id, action, entity_type, entity_id, after, context)
  values (p_actor, 'update', 'sample', p_sample,
    jsonb_build_object('ai_confidence', v_overall, 'assessment_id', v_assessment, 'status', 'awaiting_review'),
    jsonb_build_object('source', 'analyze-sample'));

  return jsonb_build_object('assessment_id', v_assessment, 'overall_confidence', v_overall);
end;
$$;

revoke all on function geo.save_assessment(uuid, uuid, jsonb) from public;
grant execute on function geo.save_assessment(uuid, uuid, jsonb) to service_role;

-- ── VERIFY — both statement_so columns present ──────────────────────────────
--   select count(*) from information_schema.columns
--     where table_schema='geo' and column_name='statement_so'
--       and table_name in ('assessment_conclusion','assessment_evidence');  -- 2

-- ── ROLLBACK ──
--   alter table geo.assessment_conclusion drop column if exists statement_so;
--   alter table geo.assessment_evidence   drop column if exists statement_so;

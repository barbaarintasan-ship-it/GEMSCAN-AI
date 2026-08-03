-- 0085_review_sample_audit_cast.sql
--
-- Bug fix: in the binding branch of review_sample (0078) the audit action was
-- written as  'review_' || v_dec  — a TEXT expression — into audit_log.action,
-- which is of enum type audit_action. Postgres implicitly casts an unknown *literal*
-- to an enum (so the draft path's literal 'review_draft' worked), but NOT a computed
-- text expression, so every binding decision (Verify / Needs More Data / Reject)
-- failed with: column "action" is of type audit_action but expression is of type text.
--
-- Fix: cast the expression to the enum → ('review_' || v_dec)::audit_action. This
-- recreates the whole function (0078) unchanged except that one line.

create or replace function enterprise.review_sample(p_actor uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = enterprise, geo, auth, pg_temp
as $$
declare
  v_sample uuid := (p_payload->>'sample_id')::uuid;
  v_role   text := coalesce(nullif(p_payload->>'reviewer_role',''), 'geologist');
  v_dec    text := nullif(p_payload->>'decision','');
  v_draft  boolean := (v_dec is null or v_dec = 'draft');
  v_round  int;
  v_review uuid;
  v_event  uuid;
  v_status text;
  v_uid    uuid;
  el jsonb;
begin
  if v_sample is null then raise exception 'validation: sample_id required'; end if;
  if not exists (select 1 from enterprise.sample where id = v_sample) then
    raise exception 'validation: sample not found'; end if;
  if not v_draft and v_dec not in ('verify','needs_more_data','reject') then
    raise exception 'validation: invalid decision %', v_dec; end if;

  -- Round: continue this reviewer's open draft, else start a new cycle.
  select id, round_no into v_review, v_round from enterprise.sample_review
    where sample_id = v_sample and reviewer_id = p_actor and status = 'draft'
    order by round_no desc limit 1;
  if v_review is null then
    select coalesce(max(round_no), 0) + 1 into v_round from enterprise.sample_review where sample_id = v_sample;
  end if;

  -- Upsert the review object.
  if v_review is null then
    insert into enterprise.sample_review
      (sample_id, reviewer_id, reviewer_role, round_no, status, decision, geologist_confidence,
       corrected_interpretation, review_notes, recommendation, evidence_references, submitted_at)
    values (v_sample, p_actor, v_role, v_round, case when v_draft then 'draft' else 'submitted' end,
       case when v_draft then null else v_dec end,
       nullif(p_payload->>'geologist_confidence','')::numeric,
       nullif(p_payload->>'corrected_interpretation',''), nullif(p_payload->>'review_notes',''),
       nullif(p_payload->>'recommendation',''), coalesce(p_payload->'evidence_references','[]'::jsonb),
       case when v_draft then null else now() end)
    returning id into v_review;
  else
    update enterprise.sample_review set
      reviewer_role = v_role,
      status = case when v_draft then 'draft' else 'submitted' end,
      decision = case when v_draft then null else v_dec end,
      geologist_confidence = nullif(p_payload->>'geologist_confidence','')::numeric,
      corrected_interpretation = nullif(p_payload->>'corrected_interpretation',''),
      review_notes = nullif(p_payload->>'review_notes',''),
      recommendation = nullif(p_payload->>'recommendation',''),
      evidence_references = coalesce(p_payload->'evidence_references','[]'::jsonb),
      submitted_at = case when v_draft then null else now() end,
      updated_at = now()
    where id = v_review;
  end if;

  -- Per-conclusion review states (§3). Only conclusions belonging to THIS sample.
  for el in select * from jsonb_array_elements(coalesce(p_payload->'conclusions','[]'::jsonb)) loop
    update geo.assessment_conclusion c set
      review_state = coalesce(nullif(el->>'state',''), c.review_state),
      reviewed_by = p_actor, reviewed_at = now(),
      corrected_statement = coalesce(nullif(el->>'corrected_statement',''), c.corrected_statement),
      corrected_statement_so = coalesce(nullif(el->>'corrected_statement_so',''), c.corrected_statement_so),
      review_note = coalesce(nullif(el->>'note',''), c.review_note)
    where c.id = (el->>'conclusion_id')::uuid
      and c.assessment_id in (select id from geo.geological_assessment where sample_id = v_sample);
  end loop;

  if v_draft then
    -- Draft: persist only, no lifecycle change or notifications. Still audited (§6).
    insert into enterprise.audit_log (actor_id, action, entity_type, entity_id, after, context)
    values (p_actor, 'review_draft', 'sample', v_sample,
      jsonb_build_object('review_id', v_review, 'round', v_round),
      jsonb_build_object('source','review-sample','role',v_role));
    return jsonb_build_object('review_id', v_review, 'round_no', v_round, 'status', 'draft');
  end if;

  -- Binding decision → advance lifecycle (ai_confidence untouched; §2).
  v_status := case v_dec when 'verify' then 'verified' when 'needs_more_data' then 'needs_more_data' else 'rejected' end;
  update enterprise.sample
    set status = v_status::sample_status,
        geologist_confidence = nullif(p_payload->>'geologist_confidence','')::numeric,
        updated_at = now()
    where id = v_sample;

  -- Discussion timeline entry (§4).
  insert into enterprise.sample_discussion (sample_id, author_id, author_role, body)
  values (v_sample, p_actor, v_role,
    format('%s: %s (round %s)%s', initcap(replace(v_role,'_',' ')),
      case v_dec when 'verify' then 'Verified' when 'needs_more_data' then 'Requested more data' else 'Rejected' end,
      v_round, coalesce(' — ' || nullif(p_payload->>'review_notes',''), '')));

  -- Notification event → collector + oversight roles (§5; channel supports email/push later).
  insert into enterprise.event (type, actor_id, subject_type, subject_id, payload)
  values ('sample.' || v_status, p_actor, 'sample', v_sample,
    jsonb_build_object('decision', v_dec, 'round', v_round, 'reviewer_role', v_role,
      'geologist_confidence', nullif(p_payload->>'geologist_confidence','')::numeric))
  returning id into v_event;

  for v_uid in
    select collector_id from enterprise.sample where id = v_sample and collector_id is not null
    union
    select user_id from enterprise.field_contributor
      where role in ('team_leader','company_manager','chief_geologist') and status = 'active'
  loop
    insert into enterprise.notification (user_id, event_id, channel) values (v_uid, v_event, 'in_app');
  end loop;

  -- Audit (§6). FIX: cast the computed action text to the audit_action enum.
  insert into enterprise.audit_log (actor_id, action, entity_type, entity_id, after, context)
  values (p_actor, ('review_' || v_dec)::audit_action, 'sample', v_sample,
    jsonb_build_object('review_id', v_review, 'round', v_round, 'status', v_status,
      'geologist_confidence', nullif(p_payload->>'geologist_confidence','')::numeric),
    jsonb_build_object('source','review-sample','role',v_role,'event',v_event));

  return jsonb_build_object('review_id', v_review, 'round_no', v_round, 'status', 'submitted',
    'decision', v_dec, 'sample_status', v_status, 'event_id', v_event);
end;
$$;

revoke all on function enterprise.review_sample(uuid, jsonb) from public;
grant execute on function enterprise.review_sample(uuid, jsonb) to service_role;

-- ── ROLLBACK ── restore the 0078 body (without the ::audit_action cast).

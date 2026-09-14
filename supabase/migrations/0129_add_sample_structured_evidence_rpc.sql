-- 0129_add_sample_structured_evidence_rpc.sql
--
-- Phase 6 — a real-world gap submit_sample alone can't cover: assay results
-- in particular routinely come back DAYS after the field visit, long after
-- the sample was already submitted. This RPC lets the sample's own collector
-- attach structured evidence after the fact, under the same RLS boundary
-- (structured_evidence_insert, 0128) and the same lab_verified downgrade
-- rule submit_sample enforces at initial submission.

create or replace function enterprise.add_sample_structured_evidence(
  p_sample uuid,
  p_evidence_type enterprise.structured_evidence_type,
  p_payload jsonb,
  p_verification_status enterprise.evidence_verification_status default 'user_reported',
  p_lab_accredited boolean default false,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = enterprise, pg_temp
as $$
declare
  v_id uuid;
  v_status enterprise.evidence_verification_status := p_verification_status;
begin
  if not exists (select 1 from enterprise.sample where id = p_sample and collector_id = auth.uid()) then
    raise exception 'forbidden: only the sample''s own collector can attach evidence to it';
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'validation: payload must be a JSON object';
  end if;

  -- Same anti-inflation gate submit_sample enforces: lab_verified requires
  -- an explicit, separate lab_accredited=true, never inferred from content.
  if v_status = 'lab_verified' and not coalesce(p_lab_accredited, false) then
    v_status := 'expert_verified';
  end if;

  insert into enterprise.sample_structured_evidence
    (sample_id, evidence_type, payload, verification_status, lab_accredited, notes, created_by)
  values (p_sample, p_evidence_type, p_payload, v_status, coalesce(p_lab_accredited, false), p_notes, auth.uid())
  returning id into v_id;

  insert into enterprise.audit_log (actor_id, action, entity_type, entity_id, after, context)
  values (auth.uid(), 'insert', 'sample', p_sample,
    jsonb_build_object('structured_evidence_id', v_id, 'evidence_type', p_evidence_type, 'verification_status', v_status),
    jsonb_build_object('source', 'enterprise.add_sample_structured_evidence'));

  return v_id;
end;
$$;
grant execute on function enterprise.add_sample_structured_evidence(
  uuid, enterprise.structured_evidence_type, jsonb, enterprise.evidence_verification_status, boolean, text
) to authenticated;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select has_function_privilege('authenticated',
--     'enterprise.add_sample_structured_evidence(uuid,enterprise.structured_evidence_type,jsonb,enterprise.evidence_verification_status,boolean,text)',
--     'execute');

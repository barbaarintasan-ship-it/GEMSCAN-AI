-- 0145_review_area_rpc.sql
--
-- Phase 11 — the atomic human-review transaction for a mission's
-- exploration_area. Records a manager's accept/reject/needs-more-data
-- decision; never touches prospectivity_score, evidence, reasons,
-- coverage (Phase 10) or the AI synthesis narrative (Phase 7) — those stay
-- exactly as the deterministic engine/AI produced them. Called by the
-- review-area Edge Function.
--
-- AUTHORIZATION: is_mission_manager(p_mission) — the SAME boundary every
-- other area-mutating RPC in this codebase already uses
-- (create_mission_area_from_target 0122, create_manual_mission_area 0137).
-- Deliberately NOT authz.ts's REVIEW_ROLES/canReview: that vocabulary is a
-- geologist-seniority credential built for SAMPLE content QA
-- (review_sample, 0078) and is not used by any area RPC today — importing
-- it here would be a second, unrelated authorization axis, and would risk
-- locking a real mission-owning customer out of reviewing their own
-- mission's area if their field_contributor.role field happens not to be
-- set to one of those exact strings. is_mission_manager already excludes
-- plain field contributors (it checks mission ownership / org owner-admin
-- role, never mere mission_contributor membership), which is the one
-- requirement Phase 11's spec was explicit about.
--
-- userClient(req) forwarded-JWT convention (not service role), matching
-- 0122/0137 — auth.uid() resolves naturally inside the SECURITY DEFINER
-- function, no explicit p_actor parameter needed (unlike review_sample,
-- which is service-role-only for a reason specific to its own call site).

create or replace function enterprise.review_area(
  p_mission uuid,
  p_area uuid,
  p_decision text,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = enterprise, pg_temp
as $$
declare
  v_role text;
  v_action enterprise.audit_action;
begin
  if not enterprise.is_mission_manager(p_mission) then
    raise exception 'forbidden: only the mission owner or an org owner/admin can review this mission''s areas';
  end if;

  if p_decision not in ('accepted', 'rejected', 'needs_more_data') then
    raise exception 'validation: decision must be one of accepted, rejected, needs_more_data';
  end if;

  if not exists (
    select 1 from enterprise.mission_area ma
    where ma.mission_id = p_mission and ma.area_id = p_area
  ) then
    raise exception 'validation: area % does not belong to mission %', p_area, p_mission;
  end if;

  select role into v_role from enterprise.field_contributor where user_id = auth.uid();

  update enterprise.exploration_area
    set review_status = p_decision::enterprise.area_review_status,
        reviewed_by = auth.uid(),
        reviewed_at = now(),
        review_notes = nullif(btrim(coalesce(p_notes, '')), ''),
        reviewer_role = coalesce(v_role, 'admin')
    where id = p_area;

  v_action := case p_decision
    when 'accepted' then 'area_review_accept'
    when 'rejected' then 'area_review_reject'
    else 'area_review_needs_more_data'
  end;

  insert into enterprise.audit_log (actor_id, action, entity_type, entity_id, after, context)
  values (auth.uid(), v_action, 'exploration_area', p_area,
    jsonb_build_object('mission_id', p_mission, 'review_status', p_decision,
      'review_notes', nullif(btrim(coalesce(p_notes, '')), '')),
    jsonb_build_object('source', 'enterprise.review_area'));

  return jsonb_build_object(
    'area_id', p_area, 'review_status', p_decision,
    'reviewed_by', auth.uid(), 'reviewed_at', now()
  );
end;
$$;
grant execute on function enterprise.review_area(uuid, uuid, text, text) to authenticated;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select has_function_privilege('authenticated', 'enterprise.review_area(uuid,uuid,text,text)', 'execute');

-- ── ROLLBACK (down-path) ────────────────────────────────────────────────────
--   drop function if exists enterprise.review_area(uuid, uuid, text, text);

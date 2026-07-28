-- 0079_reviewer_read_access.sql
--
-- Review Console S3 — reviewers must see the review QUEUE: samples in the review
-- pipeline that they did not collect. The existing read rule only allowed a
-- collector to see their own sample (or already-confirmed samples in their area).
-- Add an is_reviewer() gate so geologist/senior/chief (+admin, + owner-beta) can
-- read samples in review-stage statuses, and thread that through can_read_sample
-- (which every sample-child + assessment + review + discussion policy already uses)
-- and the sample_select policy.

create or replace function enterprise.is_reviewer()
returns boolean
language sql stable security definer
set search_path = enterprise, auth, pg_temp
as $$
  select exists (
    select 1 from enterprise.field_contributor fc
    where fc.user_id = auth.uid() and fc.status = 'active'
      and fc.role in ('geologist','senior_geologist','chief_geologist','admin')
  ) or exists (
    select 1 from auth.users u where u.id = auth.uid() and lower(u.email) = 'awmusse.musse@gmail.com'
  );
$$;
grant execute on function enterprise.is_reviewer() to authenticated, service_role;

-- Statuses a reviewer may see (the review pipeline; not other tenants' drafts).
create or replace function enterprise.can_read_sample(p_sample uuid)
returns boolean
language sql stable security definer
set search_path = enterprise, pg_temp
as $$
  select exists (
    select 1 from enterprise.sample s
    where s.id = p_sample
      and (
        s.collector_id = auth.uid()
        or (s.status in ('community_confirmed','expert_verified','lab_verified')
            and enterprise.can_read_area(s.area_id))
        or (enterprise.is_reviewer()
            and s.status in ('submitted','ai_processing','ai_completed','awaiting_review',
                             'verified','needs_more_data','rejected','held'))
      )
  );
$$;

drop policy if exists sample_select on enterprise.sample;
create policy sample_select on enterprise.sample for select to authenticated
  using (collector_id = auth.uid()
         or (status in ('community_confirmed','expert_verified','lab_verified')
             and enterprise.can_read_area(area_id))
         or (enterprise.is_reviewer()
             and status in ('submitted','ai_processing','ai_completed','awaiting_review',
                            'verified','needs_more_data','rejected','held')));

-- ── VERIFY ── owner/reviewer sees awaiting_review; a plain user does not ────
--   set local role authenticated; set local request.jwt.claims = '{"sub":"<owner>"}';
--   select count(*) from enterprise.sample where status='awaiting_review';  -- >0 for reviewer

-- ── ROLLBACK ── restore the 0037/0058 bodies (drop the is_reviewer branch).

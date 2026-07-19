-- Fixes a real race condition in 0011's evaluation-count cap, found during
-- code review: the previous design read evaluation_count in one request
-- (supabase/functions/verify-high-value/index.ts's handleRequest), then only
-- incremented it in a separate step (processVerification) after a slow
-- Gemini call completed. Two concurrent requests (a double-tap on "Get
-- Updated Evaluation", or a retried request) could both read "under the
-- cap" before either increment landed, letting a purchase exceed its
-- intended 3-evaluation limit. Worse, a transient failure AFTER the
-- increment (a failed verdict insert) permanently cost the user one of
-- their 3 evaluations for nothing.
--
-- Fix: one atomic, guarded UPDATE that checks the cap and increments in the
-- same statement (a concurrent second caller sees the already-incremented
-- value and is correctly rejected), called at the very start of
-- processVerification before any AI work happens — and a companion release
-- function that gives the slot back if the evaluation fails downstream
-- (Gemini error, parse error, or persist error), so a transient failure
-- never permanently costs the user a slot.
--
-- 0011's increment_hvr_evaluation_count is superseded — nothing in the
-- codebase calls it after this change, so it's dropped rather than left as
-- dead/confusing code.
drop function if exists public.increment_hvr_evaluation_count(uuid);

create or replace function public.reserve_hvr_evaluation_slot(p_verification_id uuid, p_max integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count integer;
begin
  update public.high_value_report_purchases
    set evaluation_count = evaluation_count + 1
    where verification_id = p_verification_id
      and status = 'paid'
      and evaluation_count < p_max
    returning evaluation_count into new_count;
  return new_count; -- null if no row matched: not paid, not found, or already at the cap
end;
$$;

create or replace function public.release_hvr_evaluation_slot(p_verification_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count integer;
begin
  update public.high_value_report_purchases
    set evaluation_count = greatest(evaluation_count - 1, 0)
    where verification_id = p_verification_id
    returning evaluation_count into new_count;
  return new_count;
end;
$$;

revoke all on function public.reserve_hvr_evaluation_slot(uuid, integer) from public;
grant execute on function public.reserve_hvr_evaluation_slot(uuid, integer) to service_role;
revoke all on function public.release_hvr_evaluation_slot(uuid) from public;
grant execute on function public.release_hvr_evaluation_slot(uuid) to service_role;

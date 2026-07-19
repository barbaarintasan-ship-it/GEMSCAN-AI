-- Caps how many times verify-high-value can run per paid report purchase.
-- Free re-evaluation after editing answers (mobile/app/(app)/scan/verify.tsx
-- "Edit Answers") is deliberate, but not unlimited: 3 evaluations total per
-- purchase (the first, payment-triggered one plus up to 2 free re-runs).

alter table public.high_value_report_purchases
  add column if not exists evaluation_count integer not null default 0;

-- Atomic increment, called by processVerification (supabase/functions/
-- verify-high-value/index.ts) via the service_role client right after a
-- verdict is successfully persisted — shared by both the payment webhook's
-- first evaluation and any direct re-evaluation call, so this is the single
-- place usage actually gets counted. security definer + a fixed search_path
-- so it can update the client-write-protected purchases row without needing
-- a broader RLS policy.
create or replace function public.increment_hvr_evaluation_count(p_verification_id uuid)
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
    returning evaluation_count into new_count;
  return new_count;
end;
$$;

revoke all on function public.increment_hvr_evaluation_count(uuid) from public;
grant execute on function public.increment_hvr_evaluation_count(uuid) to service_role;

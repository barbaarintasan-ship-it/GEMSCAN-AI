-- Atomic standard-scan accounting for the free-tier LIFETIME cap.
--
-- WHY THIS EXISTS
--   The free tier is a lifetime trial: 10 Standard scans total, ever (no daily
--   reset). The pre-existing enforcement in orchestrate-scan was a JS
--   count-then-insert against scan_usage — fine for a loose daily abuse guard,
--   but NOT safe as a hard monetization boundary:
--     * two concurrent scans could both read count=9 and both insert -> 11;
--     * a retried request (same scanId) could insert a second usage row.
--   This function moves the check+record into ONE transaction, serialized per
--   user, so the cap can never be exceeded and a scan is counted exactly once.
--
-- ACCOUNTING MODEL (reuses the existing ledger — no new counter table)
--   public.scan_usage (scan_type='standard') is the single source of truth and
--   is the only table that distinguishes standard from deep scans. Usage is
--   keyed to auth user_id, so it persists across logout/login, reinstall, and
--   device changes. Lifetime usage for EXISTING accounts is therefore already
--   present in this ledger — no backfill or reset is performed or needed.
--
--   Count rule (matches the read-side display in verify-subscription):
--     used = COUNT(DISTINCT scan_id) over standard rows in-window   -- de-dups
--          + COUNT(*) of standard rows with a NULL scan_id in-window -- can't
--            de-dup or completion-verify these, so each counts as one consumed
--            scan (conservative: never under-counts to hand out free scans).
--   Window: lifetime = all time; day = since this UTC midnight (paid tiers).
--
-- COMPLETION SEMANTICS
--   A row is reserved here (before the AI runs); orchestrate-scan best-effort
--   DELETES it if the scan then fails, so a failed scan does not consume the
--   allowance. Empirically the historical ledger is ~100% completed scans
--   (0 failed among 916 scan_id-bearing rows in production at time of writing).
--
-- This migration ADDS a function only. It modifies/deletes NO existing data and
-- is safe to replay. It is NOT applied to production by this change.

create or replace function public.consume_standard_scan(
  p_user_id  uuid,
  p_scan_id  uuid,
  p_limit    integer,        -- null = unlimited (paid abuse guard disabled)
  p_lifetime boolean,        -- true = all-time window; false = per-UTC-day
  p_plan     text,
  p_ai_models text[] default array['gemini']
)
returns table(allowed boolean, used integer, remaining integer, already_counted boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used         integer;
  v_window_start timestamptz;
  v_exists       boolean;
begin
  -- Serialize ALL standard-scan accounting for this one user for the rest of
  -- the transaction. Two concurrent scans for the same user now run this body
  -- one at a time, closing the check-then-insert race. Other users are
  -- unaffected (lock key is per user_id). Released automatically at commit.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  v_window_start := case
    when p_lifetime then '-infinity'::timestamptz
    else (date_trunc('day', now() at time zone 'utc')) at time zone 'utc'
  end;

  -- Idempotency: a standard row already exists for this scanId => this exact
  -- scan was already counted (a retry). Never insert twice, never re-block.
  if p_scan_id is not null then
    select exists(
      select 1 from public.scan_usage
      where scan_id = p_scan_id and scan_type = 'standard'
    ) into v_exists;
  else
    v_exists := false;
  end if;

  v_used := (
    select count(distinct scan_id)
    from public.scan_usage
    where user_id = p_user_id
      and scan_type = 'standard'
      and scan_id is not null
      and created_at >= v_window_start
  ) + (
    select count(*)
    from public.scan_usage
    where user_id = p_user_id
      and scan_type = 'standard'
      and scan_id is null
      and created_at >= v_window_start
  );

  if v_exists then
    return query select
      true,
      v_used,
      case when p_limit is null then null else greatest(p_limit - v_used, 0) end,
      true;
    return;
  end if;

  if p_limit is not null and v_used >= p_limit then
    return query select false, v_used, 0, false;
    return;
  end if;

  insert into public.scan_usage
    (user_id, scan_id, scan_type, ai_models_used, credits_used, subscription_plan)
  values
    (p_user_id, p_scan_id, 'standard', coalesce(p_ai_models, array['gemini']), 0, coalesce(p_plan, 'free'));

  v_used := v_used + 1;
  return query select
    true,
    v_used,
    case when p_limit is null then null else greatest(p_limit - v_used, 0) end,
    false;
end;
$$;

comment on function public.consume_standard_scan(uuid, uuid, integer, boolean, text, text[]) is
  'Atomically enforce + record one standard scan against scan_usage. Serialized per user (advisory lock); de-dups by scan_id; idempotent per scanId. Returns (allowed, used, remaining, already_counted). SECURITY DEFINER — service_role only.';

-- Writes scan_usage (service-only by RLS design); never callable by app clients.
revoke all on function public.consume_standard_scan(uuid, uuid, integer, boolean, text, text[])
  from public, anon, authenticated;

-- 0097_reclaim_stalled_analyses.sql
--
-- A run that was KILLED must not hold a sample hostage for ever.
--
-- WHY
-- ---
-- Twelve field samples sat at 'ai_processing' from one afternoon to the next with
-- ai_error null and updated_at equal to ai_attempted_at TO THE MICROSECOND —
-- meaning not one write reached the row after mark_analysis_started. That cannot
-- be a thrown error: every throw in analyze-sample is caught and recorded, and a
-- caught error writes a reason. Zero writes means no code ran at all after the
-- run began, which happens in exactly one way — the edge isolate was killed.
--
-- The cause was oversized photographs: the device uploads full sensor frames of
-- 5-7 MB, and vision base64-encoded up to 12 MB of them inside one isolate.
-- encodeBase64 is synchronous, so it blocks the event loop, and a blocked loop
-- cannot fire the timeout that was added to catch this. That is fixed separately
-- (the vision budget is now sized for what an isolate survives).
--
-- This migration fixes the OTHER half: nothing on the server ever reclaimed a
-- row whose run had died. Migration 0092 named the condition precisely in its own
-- comment — "a row with this set and status still ai_processing is a run that
-- died mid-flight" — and nothing was ever built to act on it. A killed isolate
-- runs no code, so the recovery cannot live in the function; it has to be here.
--
-- WHAT THIS IS NOT
-- ----------------
-- It is not a way to hide the failure. The reclaimed row goes to 'ai_failed'
-- WITH a reason, which is a state the collector can see and retry from. Silence
-- is what cost a day and a half; this converts silence into a stated fault.
--
-- Nothing is deleted. No photograph, observation, fix or sample is touched — only
-- the analysis status column, and only for rows whose analysis is provably dead.
--
-- Depends on: 0092 (ai_failed, ai_error, ai_attempted_at), 0093 (mark_analysis_*).

create or replace function geo.reclaim_stalled_analyses(
  p_older_than interval default interval '10 minutes'
) returns integer
language plpgsql
security definer
set search_path = geo, enterprise, public
as $$
declare
  v_count integer;
begin
  -- One statement, so the audit rows can only ever describe the rows this call
  -- actually changed. An earlier draft re-queried "samples updated in the last
  -- second", which would have logged whatever else happened to be writing at the
  -- same moment — an audit trail that invents entries is worse than none.
  --
  -- A data-modifying CTE always runs to completion whether or not the primary
  -- query reads it, so `logged` executes even though only `dead` is selected.
  with dead as (
    update enterprise.sample
       set status = 'ai_failed',
           ai_error = coalesce(
             ai_error,
             'The analysis run stopped without reporting (it was cut short mid-run, '
             || 'usually by very large photographs). Nothing you collected was lost — '
             || 'tap to run the analysis again.'
           ),
           updated_at = now()
     where deleted_at is null
       -- ONLY a run that is provably dead:
       --   still claiming to be in progress,
       --   started at a known time,
       --   and that time is further back than any real run could be.
       and status = 'ai_processing'
       and ai_attempted_at is not null
       and ai_attempted_at < now() - p_older_than
    returning id, ai_attempted_at
  ), logged as (
    -- Audited like every other status move (0093), attributed to this sweeper
    -- rather than to a person, because no person did it.
    insert into enterprise.audit_log (actor_id, action, entity_type, entity_id, after, context)
    select null, 'update', 'sample', d.id,
           jsonb_build_object('status', 'ai_failed'),
           jsonb_build_object(
             'source', 'reclaim_stalled_analyses',
             'older_than', p_older_than::text,
             'attempted_at', d.ai_attempted_at
           )
      from dead d
    returning 1
  )
  select count(*) into v_count from dead;

  return coalesce(v_count, 0);
end;
$$;

comment on function geo.reclaim_stalled_analyses(interval) is
  'Moves samples whose analysis run died mid-flight from ai_processing to ai_failed, '
  'with a reason, so they become visible and retryable instead of waiting for ever. '
  'Touches only the analysis status; never any collected data.';

revoke all on function geo.reclaim_stalled_analyses(interval) from public;
grant execute on function geo.reclaim_stalled_analyses(interval) to service_role;

-- ── Recover the rows that are stuck RIGHT NOW ───────────────────────────────
-- Run as part of this migration, because the twelve samples already stranded are
-- the reason it exists. Idempotent: a second run finds nothing to do.
select geo.reclaim_stalled_analyses(interval '10 minutes') as reclaimed;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select status, count(*) from enterprise.sample
--    where deleted_at is null group by status order by 2 desc;
--   -- expect: no ai_processing older than 10 minutes
--   select left(name,24) as name, status, left(ai_error,60) as ai_error
--     from enterprise.sample where deleted_at is null
--    order by created_at desc limit 12;

-- ── ROLLBACK (down-path) ────────────────────────────────────────────────────
--   drop function if exists geo.reclaim_stalled_analyses(interval);
--   -- The status changes are deliberate and are NOT rolled back: putting samples
--   -- back to ai_processing would restore the silence this removed.

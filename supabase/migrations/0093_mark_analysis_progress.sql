-- Record that analysis started, and record when it fails.
--
-- Companion to 0092. Separate file because Postgres forbids USING an enum value
-- in the same transaction that adds it, and 0092 adds 'ai_failed'.
--
-- Both functions are deliberately narrow: they move the status and write the
-- reason, and they touch nothing else. Neither can advance a sample past review
-- or overwrite an assessment. save_assessment remains the only path to
-- 'awaiting_review'.

-- ── Analysis has begun ──────────────────────────────────────────────────────
-- Called before any external API. Without it, "never triggered" and "triggered
-- and died" are the same row, which is exactly what made the outage
-- undiagnosable from production data.
create or replace function geo.mark_analysis_started(p_sample uuid)
returns void
language plpgsql
security definer
set search_path = geo, enterprise, public
as $$
begin
  update enterprise.sample
     set status = 'ai_processing',
         ai_attempted_at = now(),
         -- The previous failure is cleared on a fresh attempt so a stale reason
         -- is never shown beside a run that is currently in flight.
         ai_error = null,
         updated_at = now()
   where id = p_sample
     -- Only from a pre-analysis state. A reviewed sample must never be dragged
     -- backwards by a stray re-run, and a sample already carrying an assessment
     -- keeps it while a forced re-analysis runs.
     and status in ('submitted', 'ai_failed', 'ai_processing');
end;
$$;

-- ── Analysis failed ─────────────────────────────────────────────────────────
create or replace function geo.mark_analysis_failed(p_sample uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = geo, enterprise, public
as $$
begin
  update enterprise.sample
     set status = 'ai_failed',
         -- Truncated, because the reason is shown to a collector on a phone and
         -- a thousand-character stack trace helps nobody. The full text is in
         -- the function logs.
         ai_error = left(coalesce(p_reason, 'unknown error'), 500),
         updated_at = now()
   where id = p_sample
     and status in ('submitted', 'ai_processing', 'ai_failed');

  insert into enterprise.audit_log (actor_id, action, entity_type, entity_id, after, context)
  values (null, 'update', 'sample', p_sample,
    jsonb_build_object('status', 'ai_failed', 'ai_error', left(coalesce(p_reason,'unknown error'), 500)),
    jsonb_build_object('source', 'analyze-sample'));
end;
$$;

revoke all on function geo.mark_analysis_started(uuid) from public;
revoke all on function geo.mark_analysis_failed(uuid, text) from public;
grant execute on function geo.mark_analysis_started(uuid) to service_role;
grant execute on function geo.mark_analysis_failed(uuid, text) to service_role;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname='geo' and proname like 'mark_analysis%';            -- 2 rows
--   select status, ai_error, ai_attempted_at from enterprise.sample
--    where status in ('submitted','ai_processing','ai_failed')
--    order by created_at desc limit 10;

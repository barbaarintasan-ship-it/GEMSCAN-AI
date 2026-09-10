-- 0120_mission_progress_detail.sql
--
-- Phase 2D, continued — the read-only breakdown the Manager Mission Detail
-- screen needs (per-contributor sample counts, outside-assignment count,
-- last activity) cannot be assembled client-side: enterprise.sample's own
-- RLS (sample_select, 0037_sample_policies.sql) restricts SELECT to
-- `collector_id = auth.uid()` (or verified-tier samples via can_read_area) —
-- a manager querying `.from("sample")` directly would silently see only
-- their OWN rows, not the whole team's, and report a wrong number that
-- looks like a real one. This is a second narrow SECURITY DEFINER function,
-- STABLE (no writes, nothing to be idempotent about), gated by the same
-- enterprise.is_mission_member() boundary as recompute_mission_progress
-- (0119) and mission_progress's own SELECT policy — same precedent as
-- list_mission_contributors already exposing otherwise-restricted roster
-- data through a narrow RPC rather than a table grant.
--
-- No schema change. No new table. Nothing here is persisted — every call
-- recomputes directly from enterprise.sample at read time.

create or replace function enterprise.mission_progress_detail(p_mission uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = enterprise, pg_temp
as $$
declare
  v_per_contributor          jsonb;
  v_outside_assignment_count integer;
  v_last_activity_at         timestamptz;
begin
  if not enterprise.is_mission_member(p_mission) then
    raise exception 'forbidden: % is not a member of mission %', auth.uid(), p_mission;
  end if;

  select coalesce(
      jsonb_agg(jsonb_build_object('contributor_id', collector_id, 'sample_count', cnt) order by cnt desc),
      '[]'::jsonb)
    into v_per_contributor
    from (
      select collector_id, count(*) as cnt
        from enterprise.sample
        where mission_id = p_mission and deleted_at is null and collector_id is not null
        group by collector_id
    ) t;

  select count(*) into v_outside_assignment_count
    from enterprise.sample
    where mission_id = p_mission and deleted_at is null and outside_assignment = true;

  select max(created_at) into v_last_activity_at
    from enterprise.sample
    where mission_id = p_mission and deleted_at is null;

  return jsonb_build_object(
    'per_contributor', v_per_contributor,
    'outside_assignment_count', coalesce(v_outside_assignment_count, 0),
    'last_activity_at', v_last_activity_at
  );
end;
$$;

grant execute on function enterprise.mission_progress_detail(uuid) to authenticated;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select pg_get_functiondef('enterprise.mission_progress_detail(uuid)'::regprocedure) ilike '%is_mission_member%';

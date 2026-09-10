-- 0119_recompute_mission_progress.sql
--
-- Phase 2D — mission-level progress rollup. `enterprise.mission_progress`
-- has existed since 0022 with a comment promising it would be "maintained by
-- Edge Fn / cron" — nothing has ever written to it. This adds exactly one
-- RPC that recomputes it from source-of-truth tables. No schema change: the
-- table's existing three counters are all this phase fills in.
--
-- WHAT THIS DELIBERATELY DOES NOT DO (see the Phase 2D read-only audit):
--   * coverage_pct is written as 0, always, this phase. `mission_assignment.
--     target_h3` is H3 resolution 7; `sample_location.h3_cell` is resolution
--     9; the resolution-7 cell a sample actually fell in (`assignment_h3`,
--     computed server-side in enterprise-samples/handler.ts) is used
--     transiently inside submit_sample and never persisted anywhere — so
--     there is no column today that maps a sample back to the assignment
--     cell it satisfies. Faking a percentage from mismatched resolutions
--     would be a wrong number that looks like a real one. Cell-level
--     coverage is deferred until assignment-cell provenance is persisted
--     (a later phase's schema decision, not this one's).
--   * mission_assignment.status is not read here at all. Every status
--     mutation in this codebase (assign_mission_cells, 0116) only ever
--     writes 'assigned' — nothing anywhere transitions a cell to
--     in_progress/completed/skipped/expired, so treating status as a
--     completion signal would silently and permanently report zero.
--   * observation_count counts rows in rock_observation, mineral_observation,
--     alteration_observation and structural_measurement — not samples. This
--     matches the ONE semantic 'observation_count' has carried everywhere
--     else in this codebase since submit_sample's first version (0059): the
--     RPC's own v_obs_count return value has always meant "how many
--     structured observation rows", never "how many samples". sample_count
--     is the separate, correct counter for "how many samples".
--
-- Depends on: 0022 (mission_progress, exploration_mission), 0023 (sample),
-- 0024 (the four observation tables), 0041 (enterprise.is_mission_member).

create or replace function enterprise.recompute_mission_progress(p_mission uuid)
returns enterprise.mission_progress
language plpgsql
security definer
set search_path = enterprise, pg_temp
as $$
declare
  v_sample_count      integer;
  v_observation_count integer;
  v_row               enterprise.mission_progress%rowtype;
begin
  -- Same authorization boundary as mission_progress's own SELECT policy
  -- (mission_progress_select, 0041): anyone who may already read this row
  -- may also ask for it to be refreshed. This is a derived-value recompute,
  -- not a grant of new access or a change to anyone else's data — there is
  -- no reason for it to be a stricter (manager-only) boundary than reading
  -- the very table it writes.
  if not enterprise.is_mission_member(p_mission) then
    raise exception 'forbidden: % is not a member of mission %', auth.uid(), p_mission;
  end if;

  if not exists (select 1 from enterprise.exploration_mission where id = p_mission) then
    raise exception 'validation: mission % not found', p_mission;
  end if;

  -- sample_count: mission-scoped, non-deleted samples. outside_assignment
  -- samples are real evidence (H3 is a work-allocation overlay, not a
  -- geological boundary — Phase 2C) and are counted here without exception.
  select count(*) into v_sample_count
    from enterprise.sample s
    where s.mission_id = p_mission and s.deleted_at is null;

  -- observation_count: rows across the four structured-observation tables,
  -- joined through non-deleted samples of this mission. A join, not a
  -- cascade-delete assumption — sample uses soft delete (deleted_at), so an
  -- observation row for a soft-deleted sample still physically exists and
  -- must be excluded explicitly.
  select
      (select count(*) from enterprise.rock_observation ro
         join enterprise.sample s on s.id = ro.sample_id
         where s.mission_id = p_mission and s.deleted_at is null)
    + (select count(*) from enterprise.mineral_observation mo
         join enterprise.sample s on s.id = mo.sample_id
         where s.mission_id = p_mission and s.deleted_at is null)
    + (select count(*) from enterprise.alteration_observation ao
         join enterprise.sample s on s.id = ao.sample_id
         where s.mission_id = p_mission and s.deleted_at is null)
    + (select count(*) from enterprise.structural_measurement sm
         join enterprise.sample s on s.id = sm.sample_id
         where s.mission_id = p_mission and s.deleted_at is null)
  into v_observation_count;

  insert into enterprise.mission_progress (mission_id, observation_count, sample_count, coverage_pct, updated_at)
  values (p_mission, coalesce(v_observation_count, 0), coalesce(v_sample_count, 0), 0, now())
  on conflict (mission_id) do update
    set observation_count = excluded.observation_count,
        sample_count      = excluded.sample_count,
        coverage_pct      = 0,
        updated_at        = now()
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function enterprise.recompute_mission_progress(uuid) to authenticated;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select pg_get_functiondef('enterprise.recompute_mission_progress(uuid)'::regprocedure) ilike '%is_mission_member%';
--   select proacl from pg_proc where proname = 'recompute_mission_progress';

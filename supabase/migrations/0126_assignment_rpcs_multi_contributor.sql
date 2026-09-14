-- 0126_assignment_rpcs_multi_contributor.sql
--
-- Phase 4 — the three RPCs that touch enterprise.mission_assignment,
-- rewritten for the two-partial-index model from 0125. Authorization
-- boundary (is_mission_manager) is UNCHANGED everywhere. No scoring formula
-- changes — score_mission_cells's only change is WHICH ROW it writes to.

-- ── generate_mission_cells(): ON CONFLICT arbiter fixed ─────────────────────
-- Unchanged behaviour, unchanged signature. The ONLY change is the ON
-- CONFLICT predicate: it must name the surviving partial index
-- (contributor_id IS NULL) instead of the dropped one
-- (target_h3 IS NOT NULL — which was really just "unique on the pair", true
-- of every row back then). Cells this function inserts never specify
-- contributor_id, so they always land in the canonical partial index; this
-- is what makes re-running generation over an overlapping area still
-- idempotent under the new model.
create or replace function enterprise.generate_mission_cells(p_mission uuid, p_area_id uuid, p_cells text[])
returns integer
language plpgsql
security definer
set search_path = enterprise, pg_temp
as $$
declare
  v_inserted integer;
  v_cell     text;
begin
  if not enterprise.is_mission_manager(p_mission) then
    raise exception 'forbidden: only the mission owner or an org owner/admin can generate cells';
  end if;

  if not exists (
    select 1 from enterprise.mission_area where mission_id = p_mission and area_id = p_area_id
  ) then
    raise exception 'validation: area % is not linked to this mission (add a mission_area row first)', p_area_id;
  end if;

  if p_cells is null or array_length(p_cells, 1) is null then
    raise exception 'validation: no H3 cells supplied — the area produced an empty enumeration';
  end if;

  foreach v_cell in array p_cells loop
    if v_cell !~ '^[0-9a-f]{15}$' then
      raise exception 'validation: % is not a well-formed H3 cell index', v_cell;
    end if;
  end loop;

  with ins as (
    insert into enterprise.mission_assignment (mission_id, area_id, target_h3)
    select p_mission, p_area_id, c
    from unnest(p_cells) as c
    -- Was: on conflict (mission_id, target_h3) where target_h3 is not null.
    -- Now names the canonical-cell partial index from 0125.
    on conflict (mission_id, target_h3) where contributor_id is null do nothing
    returning 1
  )
  select count(*) into v_inserted from ins;

  insert into enterprise.audit_log (actor_id, action, entity_type, entity_id, after, context)
  values (auth.uid(), 'mission_generate_cells', 'exploration_mission', p_mission,
    jsonb_build_object('area_id', p_area_id, 'requested', array_length(p_cells, 1), 'inserted', v_inserted),
    jsonb_build_object('source', 'enterprise.generate_mission_cells'));

  return v_inserted;
end;
$$;
grant execute on function enterprise.generate_mission_cells(uuid, uuid, text[]) to authenticated;

-- ── score_mission_cells(): write to the canonical row ONLY ─────────────────
-- Same formula, same caller contract (Phase 3, unchanged). The only change
-- is `and ma.contributor_id is null` in the WHERE clause, so a scored cell
-- has exactly ONE authoritative score — the canonical row's — rather than
-- relying on every contributor row happening to be updated identically by
-- an unfiltered set-based UPDATE (which the Phase 4 audit flagged as a
-- correctness risk waiting to happen, not yet a bug, since contributor rows
-- never had a score of their own before this migration).
create or replace function enterprise.score_mission_cells(p_mission uuid, p_scores jsonb)
returns integer
language plpgsql
security definer
set search_path = enterprise, pg_temp
as $$
declare
  v_updated integer;
  v_requested integer;
begin
  if not enterprise.is_mission_manager(p_mission) then
    raise exception 'forbidden: only the mission owner or an org owner/admin can score cells';
  end if;

  v_requested := coalesce(jsonb_array_length(p_scores), 0);
  if v_requested = 0 then
    raise exception 'validation: no scores supplied';
  end if;

  with input as (
    select
      elem->>'target_h3' as target_h3,
      (elem->>'score')::numeric as score,
      nullif(elem->>'engine_version', '') as engine_version
    from jsonb_array_elements(p_scores) as elem
  ),
  validated as (
    select * from input
    where target_h3 ~ '^[0-9a-f]{15}$'
      and score is not null and score >= 0 and score <= 1
  ),
  upd as (
    update enterprise.mission_assignment ma
      set prospectivity_score = v.score,
          scored_at = now(),
          score_engine_version = v.engine_version
    from validated v
    where ma.mission_id = p_mission and ma.target_h3 = v.target_h3
      and ma.contributor_id is null
    returning ma.id
  )
  select count(*) into v_updated from upd;

  insert into enterprise.audit_log (actor_id, action, entity_type, entity_id, after, context)
  values (auth.uid(), 'mission_score_cells', 'exploration_mission', p_mission,
    jsonb_build_object('requested', v_requested, 'updated', v_updated),
    jsonb_build_object('source', 'enterprise.score_mission_cells'));

  return v_updated;
end;
$$;
grant execute on function enterprise.score_mission_cells(uuid, jsonb) to authenticated;

-- ── assign_mission_cells(): additive, not destructive ───────────────────────
-- OLD behaviour: UPDATE the single cell row's contributor_id (overwrite —
-- there was only ever one contributor slot).
-- NEW behaviour: INSERT a new (mission, cell, contributor) row alongside
-- whatever other contributors already hold the cell, or update that
-- contributor's OWN row's metadata (due_at/status) if they already hold it
-- — idempotent re-assignment, never touching cell intelligence either way.
-- The canonical (contributor_id IS NULL) row is NEVER written by this
-- function — it is read once, to confirm the cell has actually been
-- generated, and otherwise left untouched.
--
-- `p_reassign` is KEPT for signature/backward-compatibility (an old client
-- can still call this without erroring) but is now VESTIGIAL: there is
-- nothing to "replace" any more, since a second contributor is additive by
-- product decision, not a conflict. It is echoed into the audit context for
-- transparency and otherwise ignored. A true "remove and replace" is now
-- two explicit calls — unassign_mission_cell_contributor() then
-- assign_mission_cells() — never implied by this flag.
create or replace function enterprise.assign_mission_cells(
  p_mission uuid,
  p_cells text[],
  p_contributor_id uuid,
  p_due_at timestamptz default null,
  p_reassign boolean default false
)
returns integer
language plpgsql
security definer
set search_path = enterprise, pg_temp
as $$
declare
  v_cell        text;
  v_pool        enterprise.mission_assignment%rowtype;
  v_existing_id uuid;
  v_assigned    integer := 0;
begin
  if not enterprise.is_mission_manager(p_mission) then
    raise exception 'forbidden: only the mission owner or an org owner/admin can assign cells';
  end if;

  if not exists (
    select 1 from enterprise.mission_contributor
    where mission_id = p_mission and contributor_id = p_contributor_id
  ) then
    raise exception 'validation: the contributor must already be on this mission''s roster (add_mission_contributor first)';
  end if;

  if p_cells is null or array_length(p_cells, 1) is null then
    raise exception 'validation: no cells supplied';
  end if;

  foreach v_cell in array p_cells loop
    -- The canonical cell must already exist (generated) — same invariant as
    -- before, now checked against the canonical-row partial index instead
    -- of "the one row".
    select * into v_pool from enterprise.mission_assignment
      where mission_id = p_mission and target_h3 = v_cell and contributor_id is null;
    if not found then
      raise exception 'validation: cell % has not been generated for this mission yet', v_cell;
    end if;

    select id into v_existing_id from enterprise.mission_assignment
      where mission_id = p_mission and target_h3 = v_cell and contributor_id = p_contributor_id;

    if v_existing_id is not null then
      -- Same contributor, same cell, again — idempotent metadata update
      -- only (due_at/status). Cell intelligence (on the pool row) is never
      -- touched by this branch.
      update enterprise.mission_assignment
        set due_at = coalesce(p_due_at, due_at),
            status = 'assigned'
        where id = v_existing_id;
    else
      -- A NEW contributor on a cell that may already have others assigned —
      -- additive. Existing contributor rows for this cell are untouched.
      insert into enterprise.mission_assignment (mission_id, target_h3, contributor_id, area_id, due_at, status)
      values (p_mission, v_cell, p_contributor_id, v_pool.area_id, p_due_at, 'assigned');
    end if;
    v_assigned := v_assigned + 1;

    insert into enterprise.audit_log (actor_id, action, entity_type, entity_id, after, context)
    values (auth.uid(), 'mission_assign_cells', 'exploration_mission', p_mission,
      jsonb_build_object('target_h3', v_cell, 'contributor_id', p_contributor_id),
      jsonb_build_object('source', 'enterprise.assign_mission_cells',
        'already_held_by_this_contributor', v_existing_id is not null,
        'reassign_flag_received', p_reassign));
  end loop;

  return v_assigned;
end;
$$;
grant execute on function enterprise.assign_mission_cells(uuid, text[], uuid, timestamptz, boolean) to authenticated;

-- ── unassign_mission_cell_contributor(): the new, explicit removal path ────
-- Removes ONLY the calling contributor's own assignment row. Never touches
-- the canonical (contributor_id IS NULL) row — the cell, its
-- prospectivity_score/scored_at/area_id, and every OTHER contributor's row
-- are structurally untouched by this statement (it deletes exactly one row,
-- identified by mission+cell+contributor). Evidence already submitted
-- (enterprise.sample rows) has no FK to mission_assignment at all — nothing
-- here can delete or orphan it (see 0117/0118: samples reference
-- mission_id/area_id directly, not an assignment row).
-- Full before-state is written to audit_log BEFORE the delete — the
-- established "log then delete" pattern this codebase already uses
-- elsewhere, since assignment_status has no "removed" state to transition
-- into instead.
create or replace function enterprise.unassign_mission_cell_contributor(
  p_mission uuid,
  p_target_h3 text,
  p_contributor_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = enterprise, pg_temp
as $$
declare
  v_row enterprise.mission_assignment%rowtype;
begin
  if not enterprise.is_mission_manager(p_mission) then
    raise exception 'forbidden: only the mission owner or an org owner/admin can unassign a contributor';
  end if;

  select * into v_row from enterprise.mission_assignment
    where mission_id = p_mission and target_h3 = p_target_h3 and contributor_id = p_contributor_id;
  if not found then
    raise exception 'validation: contributor % has no assignment on cell % for this mission', p_contributor_id, p_target_h3;
  end if;

  insert into enterprise.audit_log (actor_id, action, entity_type, entity_id, before, context)
  values (auth.uid(), 'mission_unassign_cell', 'exploration_mission', p_mission,
    jsonb_build_object('target_h3', p_target_h3, 'contributor_id', p_contributor_id,
      'due_at', v_row.due_at, 'status', v_row.status, 'assignment_row_id', v_row.id),
    jsonb_build_object('source', 'enterprise.unassign_mission_cell_contributor'));

  delete from enterprise.mission_assignment where id = v_row.id;

  return true;
end;
$$;
grant execute on function enterprise.unassign_mission_cell_contributor(uuid, text, uuid) to authenticated;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname='enterprise' and proname='unassign_mission_cell_contributor';
--   select has_function_privilege('authenticated',
--     'enterprise.unassign_mission_cell_contributor(uuid,text,uuid)', 'execute');

-- ── ROLLBACK (down-path) ────────────────────────────────────────────────────
--   drop function if exists enterprise.unassign_mission_cell_contributor(uuid, text, uuid);
--   -- Restoring the previous assign_mission_cells/generate_mission_cells/
--   -- score_mission_cells bodies requires re-running their prior migration
--   -- files (0116/0124) after 0125's index rollback.

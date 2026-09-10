-- 0116_mission_h3_rpcs.sql
--
-- Phase 2B — H3 area enumeration and field assignment RPCs.
--
-- H3 polygon-fill math (h3-js) cannot run in Postgres (no h3-pg extension in
-- this project — confirmed absent). So cell ENUMERATION happens in a Deno
-- Edge Function (supabase/functions/generate-mission-cells), which computes
-- the cell list and then calls generate_mission_cells() below to persist it.
-- The Edge Function always acts as the CALLER (their forwarded JWT via
-- userClient(), never service role) — every authorization decision below is
-- still made by auth.uid() inside these SECURITY DEFINER functions, exactly
-- like Phase 2A. The Edge Function adds no privilege of its own.
--
-- Reuses the Phase 2A authorization boundary UNCHANGED (project owner /
-- org owner+admin) via one small new helper (is_mission_manager) that
-- generalises the same predicate already inlined in create_mission /
-- add_mission_contributor — Phase 2A's own RPCs are left untouched.

-- ── is_mission_manager(): the Phase 2A manager boundary, keyed by mission ──
create or replace function enterprise.is_mission_manager(p_mission uuid)
returns boolean
language sql
stable
security definer
set search_path = enterprise, pg_temp
as $$
  select exists (
    select 1
    from enterprise.exploration_mission m
    join enterprise.project p on p.id = m.project_id
    where m.id = p_mission
      and (
        m.owner_id = auth.uid()
        or (p.organization_id is null and p.owner_id = auth.uid())
        or (p.organization_id is not null and enterprise.org_role_of(p.organization_id) in ('owner', 'admin'))
      )
  );
$$;
grant execute on function enterprise.is_mission_manager(uuid) to authenticated;

-- ── area_boundary_geojson(): read-only geometry export for the Edge Function ─
-- Gated by the EXISTING can_read_area (0037) — any project member can read
-- geometry (harmless), the actual mutation (generate_mission_cells) is what
-- enforces the stricter manager boundary.
create or replace function enterprise.area_boundary_geojson(p_area uuid)
returns text
language sql
stable
security definer
set search_path = enterprise, extensions, pg_temp
as $$
  select extensions.ST_AsGeoJSON(a.boundary)
  from enterprise.exploration_area a
  where a.id = p_area and enterprise.can_read_area(p_area);
$$;
grant execute on function enterprise.area_boundary_geojson(uuid) to authenticated;

-- ── generate_mission_cells(): persist an already-computed cell list ────────
-- The Edge Function does the H3 math; this RPC only validates + writes.
-- Idempotent via ON CONFLICT on the (mission_id, target_h3) unique index
-- added in 0115 — calling this twice (or from two overlapping areas) never
-- creates duplicate assignment rows; area_id records whichever area's
-- generation call reached a given cell FIRST.
create function enterprise.generate_mission_cells(p_mission uuid, p_area_id uuid, p_cells text[])
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

  -- Defense in depth: the Edge Function already validates every cell with
  -- h3-js's own isValidCell before calling this RPC; re-check the shape
  -- server-side too rather than trusting an arbitrary text[] at the boundary.
  -- An H3 v4 cell index is 15 lowercase hex characters.
  foreach v_cell in array p_cells loop
    if v_cell !~ '^[0-9a-f]{15}$' then
      raise exception 'validation: % is not a well-formed H3 cell index', v_cell;
    end if;
  end loop;

  with ins as (
    insert into enterprise.mission_assignment (mission_id, area_id, target_h3)
    select p_mission, p_area_id, c
    from unnest(p_cells) as c
    on conflict (mission_id, target_h3) where target_h3 is not null do nothing
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

-- ── assign_mission_cells(): hand generated cells to a roster member ────────
-- A cell must already exist (i.e. have been generated) before it can be
-- assigned — enforces the two-step Generate -> Assign flow rather than
-- letting an assignment invent an ungenerated (and therefore unvalidated,
-- possibly outside-the-area) cell. An ACTIVE existing assignment to a
-- DIFFERENT contributor is protected: it is only overwritten when the
-- caller explicitly passes p_reassign=true, and the previous holder is
-- preserved in audit_log.before — never silently dropped. A previous holder
-- in a terminal state (completed/skipped/expired) is not "active" and does
-- not require the flag.
create function enterprise.assign_mission_cells(
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
  v_cell     text;
  v_row      enterprise.mission_assignment%rowtype;
  v_assigned integer := 0;
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
    select * into v_row from enterprise.mission_assignment
      where mission_id = p_mission and target_h3 = v_cell;
    if not found then
      raise exception 'validation: cell % has not been generated for this mission yet', v_cell;
    end if;

    if v_row.contributor_id is not null
       and v_row.contributor_id <> p_contributor_id
       and v_row.status not in ('completed', 'skipped', 'expired')
       and not p_reassign
    then
      raise exception 'conflict: cell % is already actively assigned to another contributor — pass reassign=true to deliberately reassign', v_cell;
    end if;

    update enterprise.mission_assignment
      set contributor_id = p_contributor_id,
          due_at = coalesce(p_due_at, due_at),
          status = 'assigned'
      where mission_id = p_mission and target_h3 = v_cell;
    v_assigned := v_assigned + 1;

    insert into enterprise.audit_log (actor_id, action, entity_type, entity_id, before, after, context)
    values (auth.uid(), 'mission_assign_cells', 'exploration_mission', p_mission,
      jsonb_build_object('target_h3', v_cell, 'previous_contributor_id', v_row.contributor_id),
      jsonb_build_object('target_h3', v_cell, 'contributor_id', p_contributor_id),
      jsonb_build_object('source', 'enterprise.assign_mission_cells',
        'reassigned', (v_row.contributor_id is not null and v_row.contributor_id <> p_contributor_id)));
  end loop;

  return v_assigned;
end;
$$;
grant execute on function enterprise.assign_mission_cells(uuid, text[], uuid, timestamptz, boolean) to authenticated;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select proname from pg_proc p join pg_namespace n on p.pronamespace = n.oid
--     where n.nspname = 'enterprise' and proname in
--     ('is_mission_manager','area_boundary_geojson','generate_mission_cells','assign_mission_cells');

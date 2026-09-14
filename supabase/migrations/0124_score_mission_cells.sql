-- 0124_score_mission_cells.sql
--
-- Phase 3 — persists deterministic per-cell scores computed server-side by
-- score-mission-cells/handler.ts via the SAME shared TargetingEngine Phase
-- 1/2 use. SERVER-AUTHORITATIVE, same pattern as
-- enterprise.create_mission_area_from_target (0122): this function does not
-- compute anything, it only validates shape and persists what the Edge
-- Function already computed. It UPDATES existing mission_assignment rows —
-- it never inserts one. A target_h3 with no matching row (i.e. never
-- generated for this mission) is silently skipped, exactly like
-- generate_mission_cells' own ON CONFLICT DO NOTHING is silent about
-- already-existing cells: scoring an ungenerated cell is not an error, it is
-- simply a no-op, because STEP A (generate) and STEP B (score) are
-- deliberately separate concerns and this function only ever does STEP B/C.
--
-- Reuses the Phase 2A/2B manager boundary (is_mission_manager, 0116)
-- unchanged.

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
    -- Same H3-cell shape check generate_mission_cells (0116) already uses.
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

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select has_function_privilege('authenticated',
--     'enterprise.score_mission_cells(uuid,jsonb)', 'execute');

-- ── ROLLBACK (down-path) ────────────────────────────────────────────────────
--   drop function if exists enterprise.score_mission_cells(uuid, jsonb);

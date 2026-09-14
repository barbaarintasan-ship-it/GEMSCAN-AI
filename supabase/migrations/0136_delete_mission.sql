-- 0136_delete_mission.sql
--
-- Lets a mission's manager delete it outright. A HARD delete, not a soft
-- one — the point of this is for a manager to actually clear test/unwanted
-- missions from their list, and the existing FK graph on
-- enterprise.exploration_mission already makes this safe without any new
-- cascade logic:
--   sample.mission_id            SET NULL  — real field evidence survives,
--                                             just detached from the deleted
--                                             mission (never destroyed)
--   expedition/survey_track.mission_id SET NULL — same
--   mission_assignment/mission_area/mission_contributor/
--     mission_progress/cell_synthesis  CASCADE — mission-scoped metadata,
--                                             safe to remove with it
--   exploration_mission.source_mission_id SET NULL — a follow-up mission
--                                             (Phase 9) survives if its
--                                             source is deleted

create or replace function enterprise.delete_mission(p_mission uuid)
returns void
language plpgsql
security definer
set search_path = enterprise, pg_temp
as $$
declare
  v_name text;
begin
  if not enterprise.is_mission_manager(p_mission) then
    raise exception 'forbidden: only the mission owner or an org owner/admin can delete this mission';
  end if;

  select name into v_name from enterprise.exploration_mission where id = p_mission;
  if v_name is null then
    raise exception 'not_found: mission not found';
  end if;

  insert into enterprise.audit_log (actor_id, action, entity_type, entity_id, after, context)
  values (auth.uid(), 'delete', 'exploration_mission', p_mission,
    jsonb_build_object('name', v_name),
    jsonb_build_object('source', 'enterprise.delete_mission'));

  delete from enterprise.exploration_mission where id = p_mission;
end;
$$;
grant execute on function enterprise.delete_mission(uuid) to authenticated;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select has_function_privilege('authenticated', 'enterprise.delete_mission(uuid)', 'execute');

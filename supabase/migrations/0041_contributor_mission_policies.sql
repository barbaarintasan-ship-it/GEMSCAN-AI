-- 0041_contributor_mission_policies.sql
--
-- Luul Scan Enterprise — Phase 1, Sprint 3 (9/N, SECURITY): the missing
-- field_contributor self-access policies and the exploration_mission +
-- mission-child read policies.
--
-- Security only (policies + grants + 1 helper) — NO schema DDL. Frozen schema
-- (0018-0032), public/consumer, production untouched. Reuses is_admin (0034),
-- is_project_member (0036). Idempotent.
--
-- field_contributor: a user may READ their own profile (admins read all) and
-- UPDATE their own row — the 0034 column GRANT limits this to safe columns
-- (home_region/training_level) and the role-protection trigger blocks
-- role/reputation/status. INSERT/DELETE remain service-role-only.
--
-- Missions: readable by mission members (owner / roster / owning-project org
-- members); ALL mission writes are SERVICE-ROLE-ONLY (mission lifecycle via the
-- Edge Functions in Sprint 5).

-- ── Helper: is the caller a member of this mission? ────────────────────────
create or replace function enterprise.is_mission_member(p_mission uuid)
returns boolean
language sql stable security definer
set search_path = enterprise, pg_temp
as $$
  select exists (
    select 1 from enterprise.exploration_mission m
    where m.id = p_mission and (
      m.owner_id = auth.uid()
      or exists (select 1 from enterprise.mission_contributor mc
                 where mc.mission_id = m.id and mc.contributor_id = auth.uid())
      or (m.project_id is not null and enterprise.is_project_member(m.project_id))
    )
  );
$$;
grant execute on function enterprise.is_mission_member(uuid) to authenticated, service_role;

-- ── field_contributor policies (grants already set in 0034) ────────────────
drop policy if exists fc_select on enterprise.field_contributor;
create policy fc_select on enterprise.field_contributor for select to authenticated
  using (user_id = auth.uid() or enterprise.is_admin());

-- own row only; column GRANT (0034) restricts to home_region/training_level,
-- role-protection trigger (0034) blocks role/reputation/status.
drop policy if exists fc_update on enterprise.field_contributor;
create policy fc_update on enterprise.field_contributor for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── Mission grants (SELECT to authenticated; full to service_role) ─────────
grant select on
  enterprise.exploration_mission, enterprise.mission_area,
  enterprise.mission_contributor, enterprise.mission_assignment,
  enterprise.mission_progress
  to authenticated;
grant select, insert, update, delete on
  enterprise.exploration_mission, enterprise.mission_area,
  enterprise.mission_contributor, enterprise.mission_assignment,
  enterprise.mission_progress
  to service_role;

-- ── Mission read policies (writes intentionally service-only) ──────────────
drop policy if exists mission_select on enterprise.exploration_mission;
create policy mission_select on enterprise.exploration_mission for select to authenticated
  using (enterprise.is_mission_member(id));

drop policy if exists mission_area_select on enterprise.mission_area;
create policy mission_area_select on enterprise.mission_area for select to authenticated
  using (enterprise.is_mission_member(mission_id));

drop policy if exists mission_contributor_select on enterprise.mission_contributor;
create policy mission_contributor_select on enterprise.mission_contributor for select to authenticated
  using (enterprise.is_mission_member(mission_id));

drop policy if exists mission_assignment_select on enterprise.mission_assignment;
create policy mission_assignment_select on enterprise.mission_assignment for select to authenticated
  using (enterprise.is_mission_member(mission_id));

drop policy if exists mission_progress_select on enterprise.mission_progress;
create policy mission_progress_select on enterprise.mission_progress for select to authenticated
  using (enterprise.is_mission_member(mission_id));

-- ── VERIFY (CI/CD) — expect: policies=7, helper=1, fc_write_policies=1(update only) ──
--   select
--     (select count(*) from pg_policies where schemaname='enterprise'
--        and tablename in ('field_contributor','exploration_mission','mission_area',
--          'mission_contributor','mission_assignment','mission_progress')) as policies,
--     (select count(*) from pg_proc p join pg_namespace n on p.pronamespace=n.oid
--        where n.nspname='enterprise' and p.proname='is_mission_member') as helper,
--     (select count(*) from pg_policies where schemaname='enterprise' and tablename='field_contributor'
--        and cmd in ('INSERT','DELETE')) as fc_insert_delete_policies; -- expect 0 (service-only)

-- ── ROLLBACK (down-path) ───────────────────────────────────────────────────
--   drop policy if exists mission_progress_select on enterprise.mission_progress;
--   drop policy if exists mission_assignment_select on enterprise.mission_assignment;
--   drop policy if exists mission_contributor_select on enterprise.mission_contributor;
--   drop policy if exists mission_area_select on enterprise.mission_area;
--   drop policy if exists mission_select on enterprise.exploration_mission;
--   drop policy if exists fc_update on enterprise.field_contributor;
--   drop policy if exists fc_select on enterprise.field_contributor;
--   revoke select, insert, update, delete on enterprise.exploration_mission, enterprise.mission_area,
--     enterprise.mission_contributor, enterprise.mission_assignment, enterprise.mission_progress from service_role;
--   revoke select on enterprise.exploration_mission, enterprise.mission_area, enterprise.mission_contributor,
--     enterprise.mission_assignment, enterprise.mission_progress from authenticated;
--   drop function if exists enterprise.is_mission_member(uuid);

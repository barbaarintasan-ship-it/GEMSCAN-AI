-- 0036_area_policies.sql
--
-- Luul Scan Enterprise — Phase 1, Sprint 3 (4/N, SECURITY): policies for
-- exploration_area and area_membership ONLY, distinguishing Community Areas
-- (project_id IS NULL) from Private Project Areas (project_id set).
--
-- Security only (policies + grants + 2 companion helpers) — NO schema DDL.
-- No sample/observation/survey/geo policies (later migrations). Frozen schema
-- (0018-0032), public/consumer, and production untouched.
--
-- Recursion safety: helpers are SECURITY DEFINER (owned by the table owner) so
-- their internal reads BYPASS RLS — no policy recursion.
--
-- Idempotent: CREATE OR REPLACE; DROP POLICY IF EXISTS before CREATE.

-- ── Companion helpers ──────────────────────────────────────────────────────
-- Private-area visibility: is the caller a member of the org that owns the
-- project that owns this area?
create or replace function enterprise.is_project_member(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = enterprise, pg_temp
as $$
  select p_project is not null and exists (
    select 1
    from enterprise.project p
    join enterprise.organization_member m on m.organization_id = p.organization_id
    where p.id = p_project and m.user_id = auth.uid()
  );
$$;

-- Area write authorization: creator, or an area team_leader/admin, or (for a
-- private area) an owner/admin of the owning project's org.
create or replace function enterprise.is_area_manager(p_area uuid)
returns boolean
language sql
stable
security definer
set search_path = enterprise, pg_temp
as $$
  select exists (
    select 1 from enterprise.exploration_area a
    where a.id = p_area and (
      a.creator_id = auth.uid()
      or exists (
        select 1 from enterprise.area_membership am
        where am.area_id = a.id and am.user_id = auth.uid()
          and am.role in ('team_leader','admin')
      )
      or (a.project_id is not null and exists (
        select 1 from enterprise.project p
        join enterprise.organization_member om on om.organization_id = p.organization_id
        where p.id = a.project_id and om.user_id = auth.uid()
          and om.role in ('owner','admin')
      ))
    )
  );
$$;

grant execute on function enterprise.is_project_member(uuid) to authenticated, service_role;
grant execute on function enterprise.is_area_manager(uuid)   to authenticated, service_role;

-- ── Base privileges (RLS narrows rows) ─────────────────────────────────────
grant select, insert, update, delete on enterprise.exploration_area to authenticated, service_role;
grant select, insert, update, delete on enterprise.area_membership  to authenticated, service_role;

-- ── exploration_area policies ──────────────────────────────────────────────
-- Community area (project_id null) = any authenticated may read; private area =
-- only members of the owning project's org.
drop policy if exists area_select on enterprise.exploration_area;
create policy area_select on enterprise.exploration_area for select to authenticated
  using (project_id is null or enterprise.is_project_member(project_id));

-- Create a community area (attributed to self) or an area inside a project you
-- belong to.
drop policy if exists area_insert on enterprise.exploration_area;
create policy area_insert on enterprise.exploration_area for insert to authenticated
  with check (creator_id = auth.uid()
              and (project_id is null or enterprise.is_project_member(project_id)));

-- Write by creator / area team-lead-admin / owning-org owner-admin.
drop policy if exists area_update on enterprise.exploration_area;
create policy area_update on enterprise.exploration_area for update to authenticated
  using (enterprise.is_area_manager(id))
  with check (enterprise.is_area_manager(id));

drop policy if exists area_delete on enterprise.exploration_area;
create policy area_delete on enterprise.exploration_area for delete to authenticated
  using (enterprise.is_area_manager(id));

-- ── area_membership policies (no self-assignment) ──────────────────────────
-- See your own membership, or the roster of areas you manage.
drop policy if exists area_membership_select on enterprise.area_membership;
create policy area_membership_select on enterprise.area_membership for select to authenticated
  using (user_id = auth.uid() or enterprise.is_area_manager(area_id));

-- Only an area manager may add members → a non-manager cannot self-assign.
drop policy if exists area_membership_insert on enterprise.area_membership;
create policy area_membership_insert on enterprise.area_membership for insert to authenticated
  with check (enterprise.is_area_manager(area_id));

drop policy if exists area_membership_update on enterprise.area_membership;
create policy area_membership_update on enterprise.area_membership for update to authenticated
  using (enterprise.is_area_manager(area_id))
  with check (enterprise.is_area_manager(area_id));

drop policy if exists area_membership_delete on enterprise.area_membership;
create policy area_membership_delete on enterprise.area_membership for delete to authenticated
  using (enterprise.is_area_manager(area_id));

-- ── VERIFY (CI/CD) — expect: policies=8, helpers=2 ─────────────────────────
--   select
--     (select count(*) from pg_policies where schemaname='enterprise'
--        and tablename in ('exploration_area','area_membership')) as policies,
--     (select count(*) from pg_proc p join pg_namespace n on p.pronamespace=n.oid
--        where n.nspname='enterprise' and p.proname in ('is_project_member','is_area_manager')) as helpers;

-- ── ROLLBACK (down-path) — drop policies, revoke grants, drop helpers ──────
--   drop policy if exists area_membership_delete on enterprise.area_membership;
--   drop policy if exists area_membership_update on enterprise.area_membership;
--   drop policy if exists area_membership_insert on enterprise.area_membership;
--   drop policy if exists area_membership_select on enterprise.area_membership;
--   drop policy if exists area_delete on enterprise.exploration_area;
--   drop policy if exists area_update on enterprise.exploration_area;
--   drop policy if exists area_insert on enterprise.exploration_area;
--   drop policy if exists area_select on enterprise.exploration_area;
--   revoke select, insert, update, delete on enterprise.exploration_area, enterprise.area_membership from authenticated, service_role;
--   drop function if exists enterprise.is_area_manager(uuid);
--   drop function if exists enterprise.is_project_member(uuid);

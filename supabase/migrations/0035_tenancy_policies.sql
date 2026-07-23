-- 0035_tenancy_policies.sql
--
-- Luul Scan Enterprise — Phase 1, Sprint 3 (3/N, SECURITY): TENANCY policies for
-- organization, organization_member, and project ONLY. No sample/observation/
-- survey/geo policies (those are later migrations).
--
-- Security only (policies + grants + one companion helper) — NO schema DDL.
-- Frozen schema (0018-0032), public/consumer, and production are untouched.
--
-- Recursion safety: policies use SECURITY DEFINER helpers (is_org_member from
-- 0034; org_role_of added here). Definer functions are owned by the migration
-- role (the table owner), so their internal reads BYPASS RLS — no policy
-- recursion when used inside organization_member's own policies.
--
-- Idempotent: CREATE OR REPLACE function; DROP POLICY IF EXISTS before CREATE;
-- GRANTs are no-ops when already present.

-- ── Companion helper: caller's org role (owner/admin/member/viewer or null) ─
create or replace function enterprise.org_role_of(p_org uuid)
returns enterprise.org_role
language sql
stable
security definer
set search_path = enterprise, pg_temp
as $$
  select role from enterprise.organization_member
  where organization_id = p_org and user_id = auth.uid();
$$;
grant execute on function enterprise.org_role_of(uuid) to authenticated, service_role;

-- ── Base privileges (RLS narrows the rows; least privilege via policies) ───
grant select, insert, update, delete on enterprise.organization        to authenticated, service_role;
grant select, insert, update, delete on enterprise.organization_member to authenticated, service_role;
grant select, insert, update, delete on enterprise.project             to authenticated, service_role;

-- ── organization policies ──────────────────────────────────────────────────
drop policy if exists org_select on enterprise.organization;
create policy org_select on enterprise.organization for select to authenticated
  using (enterprise.is_org_member(id));

drop policy if exists org_insert on enterprise.organization;
create policy org_insert on enterprise.organization for insert to authenticated
  with check (created_by = auth.uid());          -- create your own org; owner bootstrap via service-role Edge Fn

drop policy if exists org_update on enterprise.organization;
create policy org_update on enterprise.organization for update to authenticated
  using (enterprise.org_role_of(id) in ('owner','admin'))
  with check (enterprise.org_role_of(id) in ('owner','admin'));

drop policy if exists org_delete on enterprise.organization;
create policy org_delete on enterprise.organization for delete to authenticated
  using (enterprise.org_role_of(id) = 'owner');  -- owner only

-- ── organization_member policies (no self-insert) ──────────────────────────
drop policy if exists orgmember_select on enterprise.organization_member;
create policy orgmember_select on enterprise.organization_member for select to authenticated
  using (enterprise.is_org_member(organization_id));

drop policy if exists orgmember_insert on enterprise.organization_member;
create policy orgmember_insert on enterprise.organization_member for insert to authenticated
  with check (enterprise.org_role_of(organization_id) in ('owner','admin'));

drop policy if exists orgmember_update on enterprise.organization_member;
create policy orgmember_update on enterprise.organization_member for update to authenticated
  using (enterprise.org_role_of(organization_id) in ('owner','admin'))
  with check (enterprise.org_role_of(organization_id) in ('owner','admin'));

drop policy if exists orgmember_delete on enterprise.organization_member;
create policy orgmember_delete on enterprise.organization_member for delete to authenticated
  using (enterprise.org_role_of(organization_id) in ('owner','admin'));

-- ── project policies ───────────────────────────────────────────────────────
drop policy if exists project_select on enterprise.project;
create policy project_select on enterprise.project for select to authenticated
  using (visibility = 'public' or enterprise.is_org_member(organization_id));

drop policy if exists project_insert on enterprise.project;
create policy project_insert on enterprise.project for insert to authenticated
  with check (created_by = auth.uid()
              and (organization_id is null or enterprise.org_role_of(organization_id) in ('owner','admin')));

drop policy if exists project_update on enterprise.project;
create policy project_update on enterprise.project for update to authenticated
  using ((organization_id is null and owner_id = auth.uid()) or enterprise.org_role_of(organization_id) in ('owner','admin'))
  with check ((organization_id is null and owner_id = auth.uid()) or enterprise.org_role_of(organization_id) in ('owner','admin'));

drop policy if exists project_delete on enterprise.project;
create policy project_delete on enterprise.project for delete to authenticated
  using ((organization_id is null and owner_id = auth.uid()) or enterprise.org_role_of(organization_id) in ('owner','admin'));

-- ── VERIFY (CI/CD) — expect: policies=12, helper=1 ─────────────────────────
--   select
--     (select count(*) from pg_policies where schemaname='enterprise'
--        and tablename in ('organization','organization_member','project')) as policies,
--     (select count(*) from pg_proc p join pg_namespace n on p.pronamespace=n.oid
--        where n.nspname='enterprise' and p.proname='org_role_of') as helper;

-- ── ROLLBACK (down-path) — drop policies, revoke grants, drop helper ───────
--   drop policy if exists project_delete on enterprise.project;
--   drop policy if exists project_update on enterprise.project;
--   drop policy if exists project_insert on enterprise.project;
--   drop policy if exists project_select on enterprise.project;
--   drop policy if exists orgmember_delete on enterprise.organization_member;
--   drop policy if exists orgmember_update on enterprise.organization_member;
--   drop policy if exists orgmember_insert on enterprise.organization_member;
--   drop policy if exists orgmember_select on enterprise.organization_member;
--   drop policy if exists org_delete on enterprise.organization;
--   drop policy if exists org_update on enterprise.organization;
--   drop policy if exists org_insert on enterprise.organization;
--   drop policy if exists org_select on enterprise.organization;
--   revoke select, insert, update, delete on enterprise.organization, enterprise.organization_member, enterprise.project from authenticated, service_role;
--   drop function if exists enterprise.org_role_of(uuid);

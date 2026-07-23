-- 0034_rls_helpers_role_protection.sql
--
-- Luul Scan Enterprise — Phase 1, Sprint 3 (2/N, SECURITY): RLS-support helper
-- functions, the minimal schema USAGE/GRANTs they and the role-protection need,
-- column-level protection of privileged field_contributor columns, and the
-- role-protection backstop trigger.
--
-- Scope (per Sprint 3 plan): helpers + column protection + role trigger + minimal
-- grants ONLY. NO tenancy or sample-access policies (those are 0035+).
--
-- Security setting only — creates functions/trigger/grants; NO tables, columns,
-- types, constraints, indexes, or FKs. Frozen schema (0018-0032), public/consumer,
-- and production are untouched.
--
-- Idempotent: CREATE OR REPLACE for functions; DROP TRIGGER IF EXISTS before
-- CREATE; GRANT/REVOKE are no-ops when already in the target state.

-- ── RLS helper functions ───────────────────────────────────────────────────
-- SECURITY DEFINER so they can read organization_member / field_contributor
-- (RLS-enabled in 0033) to answer a membership/role question about the CURRENT
-- user only — they never return other users' data. Each pins search_path
-- (prevents search_path injection) and is STABLE (reads DB state within a
-- statement, never modifies; not VOLATILE, not IMMUTABLE). auth.uid() is
-- schema-qualified so it resolves regardless of search_path.

create or replace function enterprise.current_contributor_role()
returns enterprise.contributor_role
language sql
stable
security definer
set search_path = enterprise, pg_temp
as $$
  select role from enterprise.field_contributor where user_id = auth.uid();
$$;

create or replace function enterprise.is_org_member(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = enterprise, pg_temp
as $$
  select exists (
    select 1 from enterprise.organization_member m
    where m.organization_id = p_org and m.user_id = auth.uid()
  );
$$;

create or replace function enterprise.is_admin()
returns boolean
language sql
stable
set search_path = enterprise, pg_temp
as $$
  select coalesce(enterprise.current_contributor_role() = 'admin', false);
$$;

-- ── Minimal schema USAGE + EXECUTE grants ──────────────────────────────────
-- service_role (BYPASSRLS) needs to reach the schemas for Edge-Function writes
-- (broader table grants arrive with the access migrations 0035+). authenticated
-- needs USAGE on `enterprise` for the field_contributor column protection below
-- and for future RLS-filtered reads.
grant usage on schema enterprise, geo, ml to service_role;
grant usage on schema enterprise to authenticated;

grant execute on function enterprise.current_contributor_role() to authenticated, service_role;
grant execute on function enterprise.is_org_member(uuid) to authenticated, service_role;
grant execute on function enterprise.is_admin() to authenticated, service_role;

-- ── Column-level protection of field_contributor (anti self-escalation) ────
-- authenticated may update ONLY safe columns; role / reputation_score / status
-- are NOT granted, so any attempt to change them is rejected at the column-
-- privilege layer ("permission denied for column ..."). service_role manages the
-- privileged columns (via the set-contributor-role Edge Fn in Sprint 5).
grant select on enterprise.field_contributor to authenticated;
grant update (home_region, training_level) on enterprise.field_contributor to authenticated;
grant select, insert, update, delete on enterprise.field_contributor to service_role;

-- ── Role-protection backstop trigger ───────────────────────────────────────
-- Defense-in-depth behind the column GRANT: even if a privileged column were
-- somehow updatable, a non-service caller cannot change role/reputation/status.
create or replace function enterprise.protect_contributor_privileges()
returns trigger
language plpgsql
security invoker
set search_path = enterprise, pg_temp
as $$
begin
  if (new.role is distinct from old.role
      or new.reputation_score is distinct from old.reputation_score
      or new.status is distinct from old.status)
     and current_user not in ('service_role','postgres','supabase_admin')
  then
    raise exception 'field_contributor.role/reputation_score/status may only be changed by the service role';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_contributor on enterprise.field_contributor;
create trigger trg_protect_contributor
  before update on enterprise.field_contributor
  for each row execute function enterprise.protect_contributor_privileges();

-- ── VERIFY (CI/CD) — expect: helpers=3, trigger=1, auth_can_update_safe=2, auth_cannot_update_role=0 ──
--   select
--     (select count(*) from pg_proc p join pg_namespace n on p.pronamespace=n.oid
--        where n.nspname='enterprise'
--        and p.proname in ('current_contributor_role','is_org_member','is_admin')) as helpers,
--     (select count(*) from pg_trigger where tgname='trg_protect_contributor' and not tgisinternal) as trigger,
--     (select count(*) from information_schema.column_privileges where grantee='authenticated'
--        and table_schema='enterprise' and table_name='field_contributor'
--        and privilege_type='UPDATE' and column_name in ('home_region','training_level')) as auth_safe_cols,
--     (select count(*) from information_schema.column_privileges where grantee='authenticated'
--        and table_schema='enterprise' and table_name='field_contributor'
--        and privilege_type='UPDATE' and column_name in ('role','reputation_score','status')) as auth_privileged_cols; -- expect 0

-- ── ROLLBACK (down-path) — drop trigger/functions, revoke grants ───────────
--   drop trigger if exists trg_protect_contributor on enterprise.field_contributor;
--   drop function if exists enterprise.protect_contributor_privileges();
--   revoke update (home_region, training_level) on enterprise.field_contributor from authenticated;
--   revoke select on enterprise.field_contributor from authenticated;
--   revoke select, insert, update, delete on enterprise.field_contributor from service_role;
--   drop function if exists enterprise.is_admin();
--   drop function if exists enterprise.is_org_member(uuid);
--   drop function if exists enterprise.current_contributor_role();
--   revoke usage on schema enterprise from authenticated;
--   revoke usage on schema enterprise, geo, ml from service_role;

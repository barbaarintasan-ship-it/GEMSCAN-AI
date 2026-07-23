-- 0039_audit_event_policies.sql
--
-- Luul Scan Enterprise — Phase 1, Sprint 3 (7/N, SECURITY): policies for the
-- audit ledger and the event/notification system.
--
-- Security only (policies + grants + 1 immutability trigger) — NO schema DDL.
-- Frozen schema (0018-0032), public/consumer, production untouched. Reuses
-- helpers is_admin (0034), is_org_member (0034), org_role_of (0035).
--
-- audit_log = APPEND-ONLY for EVERYONE: admin may READ; the service role may
-- INSERT (ledger writes); NOBODY (not even admin/service/owner) may UPDATE or
-- DELETE — enforced by a trigger that fires for all roles (BYPASSRLS does not
-- bypass triggers). Idempotent.

-- ── audit_log immutability (append-only) ───────────────────────────────────
create or replace function enterprise.forbid_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'append-only table %.% : % is not permitted', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP;
end;
$$;
drop trigger if exists trg_audit_immutable on enterprise.audit_log;
create trigger trg_audit_immutable
  before update or delete on enterprise.audit_log
  for each row execute function enterprise.forbid_mutation();

-- ── Grants ─────────────────────────────────────────────────────────────────
-- audit_log: authenticated may SELECT (RLS restricts to admins); service_role
-- SELECT + INSERT only (NO update/delete granted to anyone).
grant select on enterprise.audit_log to authenticated;
grant select, insert on enterprise.audit_log to service_role;

-- event / notification: SELECT to authenticated (RLS scoped), full to service_role.
grant select on enterprise.event, enterprise.notification to authenticated;
grant select, insert, update, delete on enterprise.event, enterprise.notification to service_role;

-- notification_subscription: user-owned preferences → full CRUD for authenticated
-- (RLS restricts to own rows) + service_role.
grant select, insert, update, delete on enterprise.notification_subscription to authenticated, service_role;

-- webhook_endpoint: org owner/admin managed → CRUD for authenticated (RLS scoped)
-- + service_role.
grant select, insert, update, delete on enterprise.webhook_endpoint to authenticated, service_role;

-- ── audit_log policy: admins read only ─────────────────────────────────────
drop policy if exists audit_select on enterprise.audit_log;
create policy audit_select on enterprise.audit_log for select to authenticated
  using (enterprise.is_admin());
-- (no insert/update/delete policy → authenticated cannot write; service_role
--  inserts via BYPASSRLS; update/delete blocked for all by trg_audit_immutable)

-- ── event policies (read; writes service-only) ─────────────────────────────
drop policy if exists event_select on enterprise.event;
create policy event_select on enterprise.event for select to authenticated
  using (actor_id = auth.uid()
         or (organization_id is not null and enterprise.is_org_member(organization_id)));

-- ── notification policies (own; writes service-only) ───────────────────────
drop policy if exists notification_select on enterprise.notification;
create policy notification_select on enterprise.notification for select to authenticated
  using (user_id = auth.uid());

-- ── notification_subscription policies (own preferences, full CRUD) ────────
drop policy if exists notif_sub_select on enterprise.notification_subscription;
create policy notif_sub_select on enterprise.notification_subscription for select to authenticated
  using (user_id = auth.uid());
drop policy if exists notif_sub_insert on enterprise.notification_subscription;
create policy notif_sub_insert on enterprise.notification_subscription for insert to authenticated
  with check (user_id = auth.uid());
drop policy if exists notif_sub_update on enterprise.notification_subscription;
create policy notif_sub_update on enterprise.notification_subscription for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists notif_sub_delete on enterprise.notification_subscription;
create policy notif_sub_delete on enterprise.notification_subscription for delete to authenticated
  using (user_id = auth.uid());

-- ── webhook_endpoint policies (org owner/admin) ────────────────────────────
drop policy if exists webhook_select on enterprise.webhook_endpoint;
create policy webhook_select on enterprise.webhook_endpoint for select to authenticated
  using (enterprise.org_role_of(organization_id) in ('owner','admin'));
drop policy if exists webhook_insert on enterprise.webhook_endpoint;
create policy webhook_insert on enterprise.webhook_endpoint for insert to authenticated
  with check (enterprise.org_role_of(organization_id) in ('owner','admin'));
drop policy if exists webhook_update on enterprise.webhook_endpoint;
create policy webhook_update on enterprise.webhook_endpoint for update to authenticated
  using (enterprise.org_role_of(organization_id) in ('owner','admin'))
  with check (enterprise.org_role_of(organization_id) in ('owner','admin'));
drop policy if exists webhook_delete on enterprise.webhook_endpoint;
create policy webhook_delete on enterprise.webhook_endpoint for delete to authenticated
  using (enterprise.org_role_of(organization_id) in ('owner','admin'));

-- ── VERIFY (CI/CD) — expect: policies=11, audit_immutable_trigger=1, audit_write_grants_to_auth=0 ──
--   select
--     (select count(*) from pg_policies where schemaname='enterprise'
--        and tablename in ('audit_log','event','notification','notification_subscription','webhook_endpoint')) as policies,
--     (select count(*) from pg_trigger where tgname='trg_audit_immutable' and not tgisinternal) as audit_trigger,
--     (select count(*) from information_schema.role_table_grants where grantee in ('authenticated','service_role')
--        and table_schema='enterprise' and table_name='audit_log' and privilege_type in ('UPDATE','DELETE')) as audit_ud_grants; -- expect 0

-- ── ROLLBACK (down-path) ───────────────────────────────────────────────────
--   drop policy if exists webhook_delete on enterprise.webhook_endpoint;
--   drop policy if exists webhook_update on enterprise.webhook_endpoint;
--   drop policy if exists webhook_insert on enterprise.webhook_endpoint;
--   drop policy if exists webhook_select on enterprise.webhook_endpoint;
--   drop policy if exists notif_sub_delete on enterprise.notification_subscription;
--   drop policy if exists notif_sub_update on enterprise.notification_subscription;
--   drop policy if exists notif_sub_insert on enterprise.notification_subscription;
--   drop policy if exists notif_sub_select on enterprise.notification_subscription;
--   drop policy if exists notification_select on enterprise.notification;
--   drop policy if exists event_select on enterprise.event;
--   drop policy if exists audit_select on enterprise.audit_log;
--   drop trigger if exists trg_audit_immutable on enterprise.audit_log;
--   drop function if exists enterprise.forbid_mutation();
--   revoke select, insert, update, delete on enterprise.webhook_endpoint, enterprise.notification_subscription from authenticated, service_role;
--   revoke select, insert, update, delete on enterprise.event, enterprise.notification from service_role;
--   revoke select on enterprise.event, enterprise.notification from authenticated;
--   revoke select, insert on enterprise.audit_log from service_role;
--   revoke select on enterprise.audit_log from authenticated;

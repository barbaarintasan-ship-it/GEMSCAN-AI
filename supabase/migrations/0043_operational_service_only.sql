-- 0043_operational_service_only.sql
--
-- Luul Scan Enterprise — Phase 1, Sprint 3 (11/N, SECURITY): the operational /
-- machine-facing tables are locked to the service role.
--
-- Security only (grants + documented default-deny) — NO schema DDL, NO policies.
-- Frozen schema (0018-0032), public/consumer, production untouched. Idempotent.
--
-- These six tables are written and read exclusively by background workers and
-- Edge Functions (sync engine, sensor ingestion, processing queue, relationship
-- graph). They carry NO end-user read surface in Phase 1, so they remain
-- DEFAULT-DENY for `authenticated` (RLS is enabled from 0033 with zero policies
-- => authenticated sees nothing) and are granted only to `service_role`
-- (BYPASSRLS). This is an explicit decision, not an omission:
--
--   * sensor / sensor_capture / sensor_file — device registry + raw captures;
--     org/sample/area-scoped READ is a candidate for a later sprint but is NOT
--     exposed now.
--   * conflict_log — offline-sync conflict ledger (internal).
--   * geo_relationship — derived spatial-relationship graph (rebuilt by jobs).
--   * processing_job — async job queue (internal).
--
-- If/when any of these needs an authenticated read surface, it gets its own
-- policy migration; until then default-deny is the secure baseline.

-- ── Grants: service_role only (authenticated intentionally gets nothing) ────
grant select, insert, update, delete on
  enterprise.sensor, enterprise.sensor_capture, enterprise.sensor_file,
  enterprise.conflict_log, enterprise.geo_relationship, enterprise.processing_job
  to service_role;

-- ── VERIFY (CI/CD) — expect: policies=0, authenticated_grants=0, service_grants=24 ──
--   select
--     (select count(*) from pg_policies where schemaname='enterprise'
--        and tablename in ('sensor','sensor_capture','sensor_file','conflict_log','geo_relationship','processing_job')) as policies, -- expect 0
--     (select count(*) from information_schema.role_table_grants where grantee='authenticated'
--        and table_schema='enterprise'
--        and table_name in ('sensor','sensor_capture','sensor_file','conflict_log','geo_relationship','processing_job')) as auth_grants, -- expect 0
--     (select count(*) from information_schema.role_table_grants where grantee='service_role'
--        and table_schema='enterprise'
--        and table_name in ('sensor','sensor_capture','sensor_file','conflict_log','geo_relationship','processing_job')
--        and privilege_type in ('SELECT','INSERT','UPDATE','DELETE')) as service_grants; -- expect 24 (6 tables x 4)

-- ── ROLLBACK (down-path) ───────────────────────────────────────────────────
--   revoke select, insert, update, delete on enterprise.sensor, enterprise.sensor_capture,
--     enterprise.sensor_file, enterprise.conflict_log, enterprise.geo_relationship,
--     enterprise.processing_job from service_role;

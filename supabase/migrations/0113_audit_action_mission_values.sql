-- 0113_audit_action_mission_values.sql
--
-- Phase 2A (Team Mission Mode) needs two new audit_action labels for mission
-- lifecycle events. Added in its OWN migration, applied BEFORE the RPCs that
-- use them — exactly the two-step sequence 0084 had to introduce as a bug fix
-- after 0078 shipped a review RPC writing audit_log actions the enum didn't
-- have yet ("invalid input value for enum audit_action"). Postgres also
-- forbids using a brand-new enum value inside the SAME transaction it was
-- added in, so this cannot be folded into the RPC migration.
--
-- ADD VALUE only (never removes existing labels) — no existing audit row is
-- affected.

alter type enterprise.audit_action add value if not exists 'mission_create';
alter type enterprise.audit_action add value if not exists 'mission_add_contributor';

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select count(*) from unnest(enum_range(null::enterprise.audit_action)) v
--     where v::text in ('mission_create','mission_add_contributor'); -- = 2

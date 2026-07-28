-- 0073_rbac_professional_roles.sql
--
-- Review Console S1 — extend the role hierarchy with the professional geological
-- roles (§2). Additive ADD VALUE only. Existing values keep their meaning:
--   field_contributor = Collector, admin = Administrator. New:
--   geologist, senior_geologist, chief_geologist, company_manager.
-- Authorization logic (who can review / verify / view) lives in authz.ts (S2).

alter type enterprise.contributor_role add value if not exists 'geologist';
alter type enterprise.contributor_role add value if not exists 'senior_geologist';
alter type enterprise.contributor_role add value if not exists 'chief_geologist';
alter type enterprise.contributor_role add value if not exists 'company_manager';

-- ── VERIFY — the 4 new roles present ────────────────────────────────────────
--   select count(*) from unnest(enum_range(null::enterprise.contributor_role)) v
--     where v::text in ('geologist','senior_geologist','chief_geologist','company_manager'); -- 4

-- ── ROLLBACK ── Postgres cannot drop enum values; recreate the type to revert.

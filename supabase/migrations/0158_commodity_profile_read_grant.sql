-- 0158_commodity_profile_read_grant.sql
--
-- Phase 17 guided commodity entry (2026-09-24) — "Other mineral" needs to
-- list the commodities the backend already supports, from the ONE real
-- source (geo.commodity_profile, 23 rows) rather than a hardcoded UI list.
-- The table has RLS enabled with zero policies (unreadable by anyone but
-- service_role) — this grants read-only access to `authenticated`, the same
-- "reference data readable by any authenticated user" pattern migration
-- 0040 already established for raster_layer_registry/sensor_type/etc.
-- Read-only: no insert/update/delete grant.

grant select on geo.commodity_profile to authenticated;

drop policy if exists commodity_profile_select on geo.commodity_profile;
create policy commodity_profile_select on geo.commodity_profile for select to authenticated using (true);

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select has_table_privilege('authenticated', 'geo.commodity_profile', 'select');  -- expect true

-- ── ROLLBACK (down-path) ────────────────────────────────────────────────────
--   drop policy if exists commodity_profile_select on geo.commodity_profile;
--   revoke select on geo.commodity_profile from authenticated;

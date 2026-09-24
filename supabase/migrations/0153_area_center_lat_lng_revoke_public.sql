-- 0153_area_center_lat_lng_revoke_public.sql
--
-- Phase 16 fix — PostgreSQL grants EXECUTE to PUBLIC by default on function
-- creation. 0152 only added a GRANT to service_role and never revoked the
-- default, so enterprise.area_center_lat_lng(uuid) was callable by `anon`
-- and `authenticated` directly via PostgREST (/rest/v1/rpc/...), leaking any
-- exploration area's coordinates to anyone — the mission-membership check
-- in area-spectral-index/handler.ts never runs for a caller hitting the RPC
-- endpoint directly. Caught by the security advisor immediately after
-- deploying (mcp__supabase__get_advisors, 2026-09-24).

revoke execute on function enterprise.area_center_lat_lng(uuid) from public, anon, authenticated;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select has_function_privilege('anon', 'enterprise.area_center_lat_lng(uuid)', 'execute');           -- expect false
--   select has_function_privilege('authenticated', 'enterprise.area_center_lat_lng(uuid)', 'execute');   -- expect false
--   select has_function_privilege('service_role', 'enterprise.area_center_lat_lng(uuid)', 'execute');    -- expect true

-- ── ROLLBACK (down-path) ────────────────────────────────────────────────────
--   grant execute on function enterprise.area_center_lat_lng(uuid) to public;

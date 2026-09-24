-- 0152_area_center_lat_lng_rpc.sql
--
-- Phase 16 — tiny service-role-only helper so area-spectral-index/handler.ts
-- can read an area's centre point without parsing PostGIS WKB client-side.
-- No RLS-facing grant: only service_role calls this (the edge function has
-- already checked is_mission_member/mission_area membership itself before
-- calling it), so this stays un-granted to `authenticated`.

create or replace function enterprise.area_center_lat_lng(p_area uuid)
returns table (lat double precision, lng double precision)
language sql stable security definer
set search_path = enterprise, extensions, pg_temp
as $$
  select st_y(center::geometry), st_x(center::geometry)
  from enterprise.exploration_area
  where id = p_area and center is not null;
$$;
grant execute on function enterprise.area_center_lat_lng(uuid) to service_role;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select has_function_privilege('service_role', 'enterprise.area_center_lat_lng(uuid)', 'execute');
--   select has_function_privilege('authenticated', 'enterprise.area_center_lat_lng(uuid)', 'execute'); -- expect false

-- ── ROLLBACK (down-path) ────────────────────────────────────────────────────
--   drop function if exists enterprise.area_center_lat_lng(uuid);

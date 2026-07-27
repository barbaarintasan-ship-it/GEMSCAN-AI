-- 0067_sample_coords.sql
--
-- Sprint 4.3 (GIE) S5 glue — return a sample's lat/lng from its PostGIS point.
-- The location is stored as geography(Point) (not lat/lng columns), so analyze-
-- sample reads coordinates through this tiny SECURITY DEFINER helper rather than
-- casting geography in PostgREST. Service-role only.

create or replace function geo.sample_coords(p_sample uuid)
returns jsonb
language sql
stable
security definer
set search_path = geo, enterprise, extensions, pg_temp
as $$
  select jsonb_build_object(
    'lat', extensions.st_y(l.location::extensions.geometry),
    'lng', extensions.st_x(l.location::extensions.geometry))
  from enterprise.sample_location l
  where l.sample_id = p_sample;
$$;

revoke all on function geo.sample_coords(uuid) from public;
grant execute on function geo.sample_coords(uuid) to service_role;

-- ── VERIFY ──
--   select geo.sample_coords('<a sample id>');  -- {"lat":2.05,"lng":45.32}

-- ── ROLLBACK ──
--   drop function if exists geo.sample_coords(uuid);

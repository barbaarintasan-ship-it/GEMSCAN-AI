-- 0138_structural_features_geometry_near.sql
--
-- Closes part of the Team-scoring evidence gap documented in
-- score-mission-cells/team-targeting's own EVIDENCE_CAVEAT: structural
-- (fault/contact) evidence was never available server-side because
-- prospectivityEvidence()'s structural block reads pack.mapFeatures — a
-- client-bundled-pack-only structure — and the server never built one.
--
-- The underlying DATA already exists server-side (geo.structural_feature,
-- 6,000 rows: 40 'fault' + 5,960 'lineament', all LINESTRING geometry) and
-- geo.structural_features_near (0100-era) already returns a pre-computed
-- distance — but prospectivityEvidence() needs the actual LINE geometry (it
-- computes point-to-polyline distance itself, the same way Solo's own
-- mapFeatures.ts does), not a single distance number. This RPC returns that
-- geometry as GeoJSON so a server-side adapter (structuralPack.ts) can build
-- real PackMapFeature[] objects — the exact shape mobile's bundled pack
-- produces — and hand them to the SAME shared TargetingEngine unchanged.
--
-- 'lineament' rows are included here (not filtered out) — prospectivityEvidence()
-- itself already excludes anything that isn't kind 'fault'/'contact' from the
-- structural scoring block, the same way Solo's own pipeline does. This RPC
-- is a geometry source, not a scoring decision.

create or replace function geo.structural_features_geometry_near(
  p_lat double precision,
  p_lng double precision,
  p_radius_m double precision
)
returns table(id uuid, feature_type text, name text, source_key text, attributes jsonb, geojson text)
language sql
stable
security definer
set search_path = geo, extensions, pg_temp
as $$
  select f.id, f.feature_type, f.name, f.source_key, f.attributes,
    extensions.st_asgeojson(f.geom::extensions.geometry) as geojson
  from geo.structural_feature f
  where extensions.st_dwithin(
    f.geom,
    extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography,
    p_radius_m
  );
$$;
grant execute on function geo.structural_features_geometry_near(double precision, double precision, double precision) to authenticated;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select has_function_privilege('authenticated', 'geo.structural_features_geometry_near(double precision,double precision,double precision)', 'execute');

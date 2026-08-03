-- 0091_geo_terrain_cell.sql
--
-- Terrain intelligence storage (Field Exploration Architecture v1.1 §7.7).
--
-- DEM derivatives per H3 cell rather than a raster: the exploration engine asks
-- "what is the ground like HERE", not "render me a surface". Per-cell keeps the
-- offline pack small and the device lookup O(1).
--
-- The pack builder ALREADY reads this table (scripts/build-geo-pack.ts) and
-- degrades quietly when it is absent, so populating it is what switches the
-- TerrainProvider from dormant to live. No application code changes.
--
-- Elevation is measured, not interpreted: SRTM is a measurement of ground
-- shape, which is in scope. Spectral/remote-sensing alteration mapping remains
-- excluded (§14.1).

create table if not exists geo.terrain_cell (
  h3              text primary key,
  resolution      smallint not null,
  geom            extensions.geometry(Point, 4326) not null,   -- cell centre
  elevation_m     double precision not null,
  slope_deg       double precision not null check (slope_deg >= 0 and slope_deg <= 90),
  aspect_deg      double precision check (aspect_deg is null or (aspect_deg >= 0 and aspect_deg < 360)),
  relief_m        double precision not null default 0,          -- local max − min
  morphology      text not null check (morphology in ('ridge','slope','valley','flat')),
  drainage_dist_m double precision,                             -- null until drainage lines exist
  -- Provenance: which DEM, sampled how. A terrain row must be traceable to a
  -- measurement exactly like an occurrence is traceable to a dataset.
  dem_source      text not null,
  sample_spacing_m double precision not null,
  ingested_at     timestamptz not null default now()
);

create index if not exists idx_terrain_cell_geom on geo.terrain_cell using gist (geom);
create index if not exists idx_terrain_cell_morphology on geo.terrain_cell (morphology);

comment on table geo.terrain_cell is
  'DEM-derived terrain per H3 cell. Feeds the offline knowledge pack (terrain.json).';
comment on column geo.terrain_cell.relief_m is
  'Local relief: max minus min elevation across the sampling stencil.';
comment on column geo.terrain_cell.drainage_dist_m is
  'Distance to nearest mapped drainage. NULL while no drainage lines are loaded — never a guess.';

-- Read-only to the app roles; only the ingestion tooling writes.
grant select on geo.terrain_cell to authenticated, service_role;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select count(*) from geo.terrain_cell;
--   select morphology, count(*) from geo.terrain_cell group by 1;

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
--   drop table if exists geo.terrain_cell;

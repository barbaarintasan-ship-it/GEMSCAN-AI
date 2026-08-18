-- 0106_gis_ingestion_architecture.sql
--
-- GIS INGESTION ARCHITECTURE — makes the system READY to accept real structural
-- geology, without seeding a single fabricated feature.
--
-- geo.structural_feature (0089) already exists as PostGIS geography(Geometry,4326)
-- with a GiST index, deliberately DORMANT. This migration widens it to the full
-- required vocabulary (faults, lineaments, shear zones, contacts, fold axes),
-- adds first-class provenance columns, and introduces a LAYER AVAILABILITY
-- REGISTRY so every required GIS layer is explicitly tracked as either `loaded`
-- or `no_source_available`.
--
-- NO DATA IS SEEDED. Real vector GIS is loaded later via
-- scripts/import-structural-gis.ts. Deriving faults/lineaments from the current
-- ST_MakeEnvelope grid polygons is FORBIDDEN — that would fabricate geology
-- (Invariant 4). See docs/GIS_INGESTION.md.

-- 1 ── Widen the structural vocabulary to the full required set ───────────────
alter table geo.structural_feature drop constraint if exists ck_structural_feature_type;
alter table geo.structural_feature add constraint ck_structural_feature_type
  check (feature_type in (
    'fault', 'shear_zone', 'lineament', 'fracture_zone', 'contact', 'fold_axis'
  ));

-- 2 ── Provenance as first-class columns (previously only in attributes) ──────
alter table geo.structural_feature add column if not exists source_key text;
alter table geo.structural_feature add column if not exists confidence text
  check (confidence is null or confidence in ('high', 'medium', 'low', 'interpreted'));
alter table geo.structural_feature add column if not exists trend_deg numeric;

-- 3 ── Layer availability registry ────────────────────────────────────────────
-- The single source of truth for what real GIS is loaded vs NO SOURCE AVAILABLE.
-- The import tool flips a layer to `loaded`; the coverage panel and pack build
-- read the same fact so the app never over-claims data it does not hold.
create table if not exists geo.gis_layer_status (
  layer_key         text primary key,
  feature_type      text,
  status            text not null default 'no_source_available'
                      check (status in ('loaded', 'no_source_available', 'pending')),
  source_key        text,
  dataset_id        uuid references geo.dataset_registry(id),
  feature_count     integer not null default 0,
  -- Real, legal candidate datasets identified in the audit. POINTERS, not data.
  candidate_sources jsonb not null default '[]'::jsonb,
  notes             text,
  updated_at        timestamptz not null default now()
);
alter table geo.gis_layer_status enable row level security;
grant select on geo.gis_layer_status to service_role;

-- 4 ── Seed the REQUIRED layers — every structural layer starts NO SOURCE ─────
-- AVAILABLE. Candidate_sources record the real, legally-usable datasets to
-- ingest; they are references only. Nothing here is geometry.
insert into geo.gis_layer_status (layer_key, feature_type, status, candidate_sources, notes) values
  ('faults', 'fault', 'no_source_available',
   '[{"source":"USGS geo7_2ag — Global GIS Digital Atlas of Africa (OFR 97-470A)","licence":"public domain","scale":"~1:5M","has":"faults+contacts (line)"},
     {"source":"FAO-SWALIM Somaliland/Puntland (2012)","licence":"UN-FAO / attribution","scale":"1:750k regional, 1:250k selected"}]'::jsonb,
   'Regional faults. Load real vector GIS via scripts/import-structural-gis.ts.'),

  ('lineaments', 'lineament', 'no_source_available',
   '[{"source":"Copernicus GLO-30 DEM-derived (automated extraction)","licence":"open (Copernicus)","confidence":"interpreted","note":"NEVER present as a mapped fault; low weight, labelled source=copernicus_dem_derived"},
     {"source":"FAO-SWALIM fracture lineaments","licence":"UN-FAO / attribution"}]'::jsonb,
   'Regional lineaments. DEM-derived permitted ONLY as interpreted/low-confidence supplement.'),

  ('shear_zones', 'shear_zone', 'no_source_available',
   '[]'::jsonb,
   'No open source identified for Somalia at audit time. NO SOURCE AVAILABLE.'),

  ('contacts', 'contact', 'no_source_available',
   '[{"source":"USGS geo7_2ag contacts","licence":"public domain","scale":"~1:5M"},
     {"source":"BGS Africa Groundwater Atlas — Hydrogeology of Somalia","licence":"CC-BY-SA 3.0","scale":"1:5M"}]'::jsonb,
   'REAL vector contacts only. Deriving from the current ST_MakeEnvelope grid polygons is forbidden.'),

  ('major_trends', 'fold_axis', 'no_source_available',
   '[]'::jsonb,
   'Regional structural trends / fold axes. NO SOURCE AVAILABLE at audit time.'),

  ('occurrences', null, 'loaded',
   '[{"source":"USGS MRDS","licence":"public domain"},
     {"source":"USGS Africa Mineral Industries geodatabase","licence":"public/open"}]'::jsonb,
   '159 loaded (usgs_mrds). Sparse in NW Somalia — supplement with USGS Africa Mineral Industries geodatabase.')
on conflict (layer_key) do nothing;

-- ── VERIFY ────────────────────────────────────────────────────────────────
--   select layer_key, status, feature_count from geo.gis_layer_status order by layer_key;
--   -- every structural layer is 'no_source_available' until real GIS is imported.
--
-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--   drop table if exists geo.gis_layer_status;
--   alter table geo.structural_feature drop column if exists source_key;
--   alter table geo.structural_feature drop column if exists confidence;
--   alter table geo.structural_feature drop column if exists trend_deg;

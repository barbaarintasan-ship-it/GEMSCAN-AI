-- 0160 — Somalia Historical Mineral Intelligence: FIREWALLED staging tables.
--
-- WHY A NEW TABLE, NOT geo.mineral_occurrence (audited decision):
--   geo.occurrences_near() (0058) selects EVERY row of geo.mineral_occurrence
--   with geometry in radius, with NO tier/provisional/status filter, and the
--   occurrence provider scores each at "mapped" weight. Inserting historical
--   or anomaly rows there would therefore SILENTLY change production
--   prospectivity scores near those localities — a hard-stop violation.
--   These two tables are read by NO scoring path, NO RPC, NO Edge Function.
--   They are additive, queryable, and completely firewalled from the engine
--   until a deliberate, separately-reviewed scoring phase (not this one).
--
-- EVIDENCE DISCIPLINE ENFORCED IN SCHEMA: evidence_type is CHECK-constrained,
--   so an anomaly can never be silently stored as an occurrence.
--
-- COORDINATES: geom is intentionally left NULL for every row inserted here.
--   The recovered sources give place names, not numeric coordinates; we do NOT
--   fabricate a coordinate. geom is populated later ONLY by a real gazetteer or
--   georeferencing step, at which point location_method / positional_uncertainty_m
--   record how it was derived.
--
-- IDEMPOTENT (create if not exists + WHERE NOT EXISTS on natural keys).
-- REVERSIBLE (drop blocks at end). NO existing object is modified.

-- ── 1. Historical mineral records (occurrences, workings, anomalies, claims) ─
create table if not exists geo.historical_mineral_record (
  id                       uuid primary key default gen_random_uuid(),
  source_id                uuid references geo.knowledge_source(id),
  commodity                text,
  name                     text not null,              -- verbatim locality / place name
  original_place_name      text,                       -- source spelling, if different
  region                   text,
  geom                     extensions.geometry(Point, 4326),   -- NULL until georeferenced/gazetteer-resolved
  evidence_type            text not null,
  location_method          text not null default 'none',
  positional_uncertainty_m numeric,
  coordinate_confidence    text,
  geological_confidence    text,
  provisional              boolean not null default true,
  mrds_relation            text,                       -- link to MRDS when the same locality already exists
  reference                text,
  metadata                 jsonb not null default '{}'::jsonb,
  created_at               timestamptz not null default now(),
  -- Evidence level can never be silently upgraded past what the source supports:
  constraint historical_evidence_type_chk check (evidence_type in (
    'mapped_occurrence','sampled_occurrence','artisanal_working','geochemical_anomaly',
    'exploration_target','historical_claim','geological_indication','reference_only','rumor')),
  constraint historical_location_method_chk check (location_method in (
    'numeric_coord','map_derived','placename_gazetteer','inferred','none')),
  constraint historical_mrds_relation_chk check (mrds_relation is null or mrds_relation in (
    'possible_duplicate','same_locality','source_correlated','not_yet_verified','not_applicable'))
);
comment on table geo.historical_mineral_record is
  'Firewalled historical/anomaly records (0160). Read by NO scoring path. geom NULL until a real georeference/gazetteer step. provisional=true; never a calibration/AUC label.';

create index if not exists historical_mineral_record_geom_gix on geo.historical_mineral_record using gist (geom);
create index if not exists historical_mineral_record_commodity_ix on geo.historical_mineral_record (commodity);

-- ── 2. Map georeferencing queue (staging; production geometry only at the end) ─
create table if not exists geo.map_georef_queue (
  id                 uuid primary key default gen_random_uuid(),
  source_id          uuid references geo.knowledge_source(id),
  plate_name         text not null,
  map_year           integer,
  description        text,
  source_uri         text,
  status             text not null default 'pending',
  georef_geometry    extensions.geometry(Geometry, 4326),  -- populated only when georeferenced+reviewed
  positional_uncertainty_note text,
  reviewer           text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint georef_status_chk check (status in (
    'pending','source_recovered','georeferenced','digitized','reviewed','production_ready'))
);
comment on table geo.map_georef_queue is
  'Map plates awaiting georeferencing (0160). Only status=production_ready geometry may ever become a real occurrence/feature — via a separate reviewed step.';

-- ── 3. Seed historical records (geom NULL — named localities only) ──────────
with src as (
  select ks.id, ks.title from geo.knowledge_source ks
  join geo.dataset_registry d on d.id = ks.dataset_id
  where d.source_key = 'somalia_historical_sources')
insert into geo.historical_mineral_record
  (source_id, commodity, name, original_place_name, region, evidence_type, location_method,
   coordinate_confidence, geological_confidence, provisional, mrds_relation, reference, metadata)
select s.id, v.commodity, v.name, v.original_place_name, v.region, v.evidence_type, 'none',
       'pending_gazetteer', v.geological_confidence, true, v.mrds_relation, v.reference, v.metadata
from (values
  ('gold','Milxo gold workings','Milxo','NE Somalia (SSC-Khatumo / Sanaag-Sool)','artisanal_working',
    'low','Active artisanal workings: 20 sites / 18 entities (Global Initiative 2025). MRDS gold=0.',
    'not_applicable','Global Initiative 2025',
    'Global Initiative Against Transnational Organized Crime — Milxo gold-rush field study',
    jsonb_build_object('nearest_feature','Golis Mountains','export_route','Bosaso->Dubai')),
  ('gold','Irshida (Cirshida) gold occurrence','Cirshida','Sanaag','sampled_occurrence',
    'low-moderate','Greenstone belt; large shear zones; epidote-rich veining; nugget rush (Somaliland Standard).',
    'not_applicable','Tahir / Somaliland Standard',
    'Somaliland Standard — The Gold Producing Potential of Somaliland',
    jsonb_build_object('setting','greenstone_belt','alias','Irshida/Cirshida — verify, do not auto-merge')),
  ('gold','Mait gold occurrence','Mait','Sanaag (Erigavo area)','sampled_occurrence',
    'low','Greenstone belt, grouped with Irshida (Somaliland Standard).','not_applicable',
    'Tahir / Somaliland Standard','Somaliland Standard — The Gold Producing Potential of Somaliland',
    jsonb_build_object('setting','greenstone_belt')),
  ('gold','Abdul Qadr gold/base-metal geochemical anomaly','Abdul Qadr',null,'geochemical_anomaly',
    'low','GEOCHEMICAL ANOMALY ONLY — "numerous gold and base-metal anomalies"; NOT an occurrence.',
    'not_applicable','Tahir / Somaliland Standard','Somaliland Standard — The Gold Producing Potential of Somaliland',
    jsonb_build_object('evidence_note','anomaly_not_occurrence')),
  ('gold','Arabsiyo gold/base-metal geochemical anomaly','Arabsiyo',null,'geochemical_anomaly',
    'low','GEOCHEMICAL ANOMALY ONLY; NOT an occurrence.','not_applicable',
    'Tahir / Somaliland Standard','Somaliland Standard — The Gold Producing Potential of Somaliland',
    jsonb_build_object('evidence_note','anomaly_not_occurrence')),
  ('titanium;iron;ree','Batalaleh heavy-mineral beach sands','Batalaleh','Berbera coast, N Somalia','sampled_occurrence',
    'moderate','Black heavy-mineral beach sands: ilmenite, magnetite, monazite, zircon (Jobstraibizer 1993). MRDS Ti=0.',
    'not_applicable','Jobstraibizer 1993 (GEOSOM 87)',
    'Jobstraibizer, P.G. 1993 — Black Heavy-Mineral Beach Sands from Batalaleh',
    jsonb_build_object('heavy_minerals','ilmenite;magnetite;monazite;zircon','alias','Batalale/Batalaleh — verify'))
  -- NOTE: the Berbera-area gypsum record (Pamphlet No.1, 1954) is intentionally
  -- NOT seeded here — reconciliation flagged it POSSIBLE_DUPLICATE of MRDS
  -- "Suria Malableh" (~16km SE of Berbera). Its provenance is preserved as a
  -- knowledge_source in 0159; it is held out of the occurrence-shaped record set
  -- pending consultation of the Pamphlet No.1 plate.
) as v(commodity, name, original_place_name, region, evidence_type, geological_confidence, gc_note, mrds_relation, ref_src, reference, metadata)
-- Robust provenance link: each v.reference is a prefix of the matching
-- knowledge_source.title (0159 titles carry extra "(...)" suffixes). Prefix
-- match avoids brittle exact-string coupling between the two migrations.
join src s on s.title like v.reference || '%'
where not exists (
  select 1 from geo.historical_mineral_record h where h.name = v.name);

-- ── 4. Seed map georeferencing queue ────────────────────────────────────────
with src as (
  select ks.id, ks.title from geo.knowledge_source ks
  join geo.dataset_registry d on d.id = ks.dataset_id
  where d.source_key = 'somalia_historical_sources')
insert into geo.map_georef_queue (source_id, plate_name, map_year, description, source_uri, status, positional_uncertainty_note)
select s.id, v.plate_name, v.map_year, v.description, v.source_uri, 'pending', v.unc
from (values
  ('Plan of Dalan Cassiterite Prospect', 1960,
    'Pit and trench diagrams of the Dalan cassiterite working (Appendix 1, Greenwood 1960). Highest georef value — trench-level detail. The occurrence itself is already MRDS "Dalan Prospect".',
    null,'Trench-level once georeferenced; ~10s of metres','Plan of Dalan Cassiterite Prospect (pit and trench diagrams) — Appendix to Greenwood 1960 Las Khoreh–Elayu report'),
  ('Berbera Sheet geological map 1:125,000', 1955,
    'Full colour geological map, Directorate of Colonial Surveys. Lithology polygons + any plotted mineral localities.',
    'https://searchworks.stanford.edu/view/11870448','~map scale; requires georeferencing','Plan of Dalan Cassiterite Prospect (pit and trench diagrams) — Appendix to Greenwood 1960 Las Khoreh–Elayu report'),
  ('Forman 1963 Bur Region photogeological interpretation', 1963,
    'Photogeology map of the Bur basement mineral province.', null,'regional; requires georeferencing',
    'Forman, H.D. 1963 — A Photogeological Interpretation of the Bur Region, Somali Republic')
) as v(plate_name, map_year, description, source_uri, unc, ref_src)
join src s on s.title = v.ref_src
where not exists (select 1 from geo.map_georef_queue q where q.plate_name = v.plate_name);

-- ── DOWN (manual, if ever needed) ───────────────────────────────────────────
-- drop table if exists geo.map_georef_queue;
-- drop table if exists geo.historical_mineral_record;

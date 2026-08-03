-- 0089_structural_feature.sql
--
-- EMIE — Structural Geology Provider data table. ARCHITECTURE ONLY: the table and
-- its spatial RPC exist so a Structural Geology Provider can be wired now, but it
-- stays DORMANT (returns nothing) until faults / shear zones / lineaments / fracture
-- zones are actually loaded. No remote sensing, no data seeded here by design.

create table if not exists geo.structural_feature (
  id           uuid primary key default gen_random_uuid(),
  feature_type text not null,        -- fault | shear_zone | lineament | fracture_zone
  name         text,
  geom         extensions.geography(Geometry,4326) not null,
  attributes   jsonb not null default '{}'::jsonb,
  dataset_id   uuid references geo.dataset_registry(id),
  created_at   timestamptz not null default now(),
  constraint ck_structural_feature_type
    check (feature_type in ('fault','shear_zone','lineament','fracture_zone'))
);
create index if not exists idx_structural_feature_geom on geo.structural_feature using gist (geom);

alter table geo.structural_feature enable row level security;
grant select on geo.structural_feature to service_role;

-- ── VERIFY ── table present + empty (dormant) ───────────────────────────────
--   select count(*) from geo.structural_feature;  -- 0 until data loaded

-- ── ROLLBACK ──
--   drop table if exists geo.structural_feature;

-- 0024_observations.sql
--
-- Luul Scan Enterprise — Phase 1, Sprint 2 (6/14): geological observations tied
-- to a sample — rock, mineral, alteration, and structural measurements.
--
-- Additive & isolated (enterprise only). Idempotent. Depends on: 0018 (enums
-- obs_method/alteration_type/alteration_grade/structure_type), 0019
-- (taxonomy_node for the controlled-vocabulary link), 0023 (sample).
--
-- Observations carry a nullable taxonomy_node_id (A3.1.1) alongside the legacy
-- free-text field during the transition to the controlled vocabulary.

-- ── Rock observation ───────────────────────────────────────────────────────
create table if not exists enterprise.rock_observation (
  id               uuid primary key default gen_random_uuid(),
  sample_id        uuid not null references enterprise.sample(id) on delete cascade,
  taxonomy_node_id uuid references enterprise.taxonomy_node(id) on delete set null,
  rock_class       text,                                    -- transitional free text
  host_type        text,
  texture          text,
  weathering       text,
  vein_presence    boolean,
  notes            text,
  method           enterprise.obs_method not null default 'field',
  created_at       timestamptz not null default now()
);
create index if not exists idx_rock_obs_sample on enterprise.rock_observation(sample_id);
create index if not exists idx_rock_obs_node on enterprise.rock_observation(taxonomy_node_id);

-- ── Mineral observation ────────────────────────────────────────────────────
create table if not exists enterprise.mineral_observation (
  id               uuid primary key default gen_random_uuid(),
  sample_id        uuid not null references enterprise.sample(id) on delete cascade,
  taxonomy_node_id uuid references enterprise.taxonomy_node(id) on delete set null,
  mineral          text,                                    -- transitional free text
  indicator_flags  jsonb,                                   -- pathfinder flags
  method           enterprise.obs_method not null default 'field',
  confidence       numeric(5,2),
  created_at       timestamptz not null default now(),
  constraint ck_mineral_obs_confidence check (confidence is null or (confidence >= 0 and confidence <= 100))
);
create index if not exists idx_mineral_obs_sample on enterprise.mineral_observation(sample_id);
create index if not exists idx_mineral_obs_node on enterprise.mineral_observation(taxonomy_node_id);
create index if not exists idx_mineral_obs_flags on enterprise.mineral_observation using gin (indicator_flags);

-- ── Alteration observation (A2.3.4) ────────────────────────────────────────
create table if not exists enterprise.alteration_observation (
  id              uuid primary key default gen_random_uuid(),
  sample_id       uuid not null references enterprise.sample(id) on delete cascade,
  alteration_type enterprise.alteration_type,
  intensity       enterprise.alteration_grade,
  notes           text,
  method          enterprise.obs_method not null default 'field',
  created_at      timestamptz not null default now()
);
create index if not exists idx_alteration_obs_sample on enterprise.alteration_observation(sample_id);
create index if not exists idx_alteration_obs_type on enterprise.alteration_observation(alteration_type);

-- ── Structural measurement (A2.3.4) ────────────────────────────────────────
create table if not exists enterprise.structural_measurement (
  id             uuid primary key default gen_random_uuid(),
  sample_id      uuid not null references enterprise.sample(id) on delete cascade,
  structure_type enterprise.structure_type,
  strike_deg     numeric(5,2),
  dip_deg        numeric(5,2),
  dip_direction  numeric(5,2),
  notes          text,
  created_at     timestamptz not null default now(),
  constraint ck_struct_strike check (strike_deg    is null or (strike_deg    >= 0 and strike_deg    <= 360)),
  constraint ck_struct_dip    check (dip_deg       is null or (dip_deg       >= 0 and dip_deg       <= 90)),
  constraint ck_struct_dipdir check (dip_direction is null or (dip_direction >= 0 and dip_direction <= 360))
);
create index if not exists idx_struct_sample on enterprise.structural_measurement(sample_id);
create index if not exists idx_struct_type on enterprise.structural_measurement(structure_type);

-- ── VERIFY (CI/CD) — expect: tables=4, fks(->sample)=4, gin=1, struct_checks=3 ──
--   select
--     (select count(*) from information_schema.tables where table_schema='enterprise'
--        and table_name in ('rock_observation','mineral_observation','alteration_observation','structural_measurement')) as tables,
--     (select count(*) from pg_constraint c join pg_class t on c.conrelid=t.oid join pg_class r on c.confrelid=r.oid
--        where c.contype='f' and r.relname='sample'
--        and t.relname in ('rock_observation','mineral_observation','alteration_observation','structural_measurement')) as fks_to_sample,
--     (select count(*) from pg_indexes where schemaname='enterprise' and indexdef like '%gin%'
--        and tablename='mineral_observation') as gin,
--     (select count(*) from pg_constraint c join pg_class t on c.conrelid=t.oid
--        where c.contype='c' and t.relname='structural_measurement') as struct_checks;

-- ── ROLLBACK (down-path) — clean drop; never touches `public`/auth ─────────
--   drop table if exists enterprise.structural_measurement;
--   drop table if exists enterprise.alteration_observation;
--   drop table if exists enterprise.mineral_observation;
--   drop table if exists enterprise.rock_observation;

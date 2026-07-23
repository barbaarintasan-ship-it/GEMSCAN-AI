-- 0031_ml.sql
--
-- Luul Scan Enterprise — Phase 1, Sprint 2 (13/14): ML PLACEHOLDER tables and
-- dataset versioning. Interfaces only — NO models, NO AI logic. These let the
-- Phase 6 AI layer land without schema changes, and let every future model
-- record which dataset version it was trained on (reproducibility).
--
-- Additive & isolated (`ml` + `enterprise`). Idempotent. Depends on: 0018
-- (schemas ml/enterprise).

-- ── Feature store (placeholder) ────────────────────────────────────────────
create table if not exists ml.ml_feature (
  entity_type text not null,                              -- area|cell|sample
  entity_id   text not null,
  features    jsonb not null,
  computed_at timestamptz not null default now(),
  primary key (entity_type, entity_id, computed_at)
);
create index if not exists idx_ml_feature_entity on ml.ml_feature(entity_type, entity_id);

-- ── Model registry (placeholder — populated in Phase 6) ────────────────────
create table if not exists ml.ml_model (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  kind       text not null,
  version    text not null,
  metrics    jsonb,
  trained_at timestamptz,
  status     text,                                        -- draft|active|retired
  constraint uq_ml_model unique (name, version)
);

-- ── Model scores (placeholder; probabilistic outputs) ──────────────────────
create table if not exists ml.ml_score (
  id          uuid primary key default gen_random_uuid(),
  model_id    uuid references ml.ml_model(id) on delete set null,
  entity_type text not null,
  entity_id   text not null,
  score       numeric(6,3),
  probability numeric(5,4),
  explanation jsonb,                                      -- contributing features (explainable AI hook)
  scored_at   timestamptz not null default now()
);
create index if not exists idx_ml_score_entity on ml.ml_score(entity_type, entity_id);
create index if not exists idx_ml_score_model on ml.ml_score(model_id);

-- ── Dataset versioning (reproducibility — "Model v1 trained on Dataset v7") ─
create table if not exists enterprise.data_version (
  id               uuid primary key default gen_random_uuid(),
  version          text not null unique,
  created_at       timestamptz not null default now(),
  sample_count     integer,
  verified_count   integer,
  coverage_percent numeric(5,2),
  notes            text,
  constraint ck_data_version_coverage check (coverage_percent is null or (coverage_percent >= 0 and coverage_percent <= 100))
);

-- ── VERIFY (CI/CD) — expect: ml_tables=3, data_version=1 ───────────────────
--   select
--     (select count(*) from information_schema.tables where table_schema='ml'
--        and table_name in ('ml_feature','ml_model','ml_score')) as ml_tables,
--     (select count(*) from information_schema.tables where table_schema='enterprise' and table_name='data_version') as data_version;

-- ── ROLLBACK (down-path) — clean drop; never touches `public`/auth ─────────
--   drop table if exists enterprise.data_version;
--   drop table if exists ml.ml_score;
--   drop table if exists ml.ml_model;
--   drop table if exists ml.ml_feature;

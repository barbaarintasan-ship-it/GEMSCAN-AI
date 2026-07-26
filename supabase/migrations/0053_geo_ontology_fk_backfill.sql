-- 0053_geo_ontology_fk_backfill.sql
--
-- Luul Scan — GeoContext P0 (10/N): ontology FK backfill & constraints.
--
-- ADDITIVE only. Adds the ontology FK columns to geo.geological_knowledge, backfills
-- them from the existing *_key TEXT columns (0046) by matching ontology.code, wires
-- the FK constraints + indexes, and links geo.deposit_style to the canonical
-- enterprise.deposit_model. NO existing column or data is dropped or modified — the
-- *_key columns are preserved as-is (source-of-record for the mapping / audit).
--
--  * FK on-delete = SET NULL — deleting an ontology term never destroys a knowledge
--    fact; the original *_key text remains. Data-preserving (ADR-0002 spirit).
--  * Backfill only fills rows where *_id is NULL, so re-running is a safe no-op
--    (idempotent). Any *_key with no matching ontology.code stays unmapped (*_id NULL)
--    and is reported, never silently coerced.
--  * deposit_style ↔ deposit_model: a nullable FK column (the agreed "clear link");
--    populated by shared code where deposit_model is seeded. Nullable so it never
--    blocks inserts while deposit_model is still empty.
--
-- geo schema, frozen core/public untouched. Idempotent.

-- ── 1. Add nullable FK columns to geological_knowledge (additive) ───────────
alter table geo.geological_knowledge
  add column if not exists commodity_id        uuid,
  add column if not exists deposit_style_id     uuid,
  add column if not exists host_rock_id         uuid,
  add column if not exists lithology_id         uuid,
  add column if not exists formation_id         uuid,
  add column if not exists tectonic_setting_id  uuid;

-- ── 2. FK constraints (idempotent guards), ON DELETE SET NULL ───────────────
do $$
begin
  if not exists (select 1 from pg_constraint where conname='fk_gk_commodity') then
    alter table geo.geological_knowledge add constraint fk_gk_commodity
      foreign key (commodity_id) references geo.commodity(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname='fk_gk_deposit_style') then
    alter table geo.geological_knowledge add constraint fk_gk_deposit_style
      foreign key (deposit_style_id) references geo.deposit_style(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname='fk_gk_host_rock') then
    alter table geo.geological_knowledge add constraint fk_gk_host_rock
      foreign key (host_rock_id) references geo.host_rock(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname='fk_gk_lithology') then
    alter table geo.geological_knowledge add constraint fk_gk_lithology
      foreign key (lithology_id) references geo.lithology(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname='fk_gk_formation') then
    alter table geo.geological_knowledge add constraint fk_gk_formation
      foreign key (formation_id) references geo.formation(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname='fk_gk_tectonic_setting') then
    alter table geo.geological_knowledge add constraint fk_gk_tectonic_setting
      foreign key (tectonic_setting_id) references geo.tectonic_setting(id) on delete set null;
  end if;
end $$;

-- ── 3. Backfill *_id from *_key by matching ontology.code (only NULL *_id) ──
update geo.geological_knowledge gk set commodity_id = c.id
  from geo.commodity c where gk.commodity_key = c.code and gk.commodity_id is null;
update geo.geological_knowledge gk set deposit_style_id = d.id
  from geo.deposit_style d where gk.deposit_style_key = d.code and gk.deposit_style_id is null;
update geo.geological_knowledge gk set host_rock_id = h.id
  from geo.host_rock h where gk.host_rock_key = h.code and gk.host_rock_id is null;
update geo.geological_knowledge gk set lithology_id = l.id
  from geo.lithology l where gk.lithology_key = l.code and gk.lithology_id is null;
update geo.geological_knowledge gk set formation_id = f.id
  from geo.formation f where gk.formation_key = f.code and gk.formation_id is null;
update geo.geological_knowledge gk set tectonic_setting_id = ts.id
  from geo.tectonic_setting ts where gk.tectonic_setting_key = ts.code and gk.tectonic_setting_id is null;

-- ── 4. Indexes on the FK columns ───────────────────────────────────────────
create index if not exists idx_gk_commodity_id on geo.geological_knowledge (commodity_id);
create index if not exists idx_gk_deposit_style_id on geo.geological_knowledge (deposit_style_id);
create index if not exists idx_gk_host_rock_id on geo.geological_knowledge (host_rock_id);
create index if not exists idx_gk_lithology_id on geo.geological_knowledge (lithology_id);
create index if not exists idx_gk_formation_id on geo.geological_knowledge (formation_id);
create index if not exists idx_gk_tectonic_setting_id on geo.geological_knowledge (tectonic_setting_id);

-- ── 5. deposit_style ↔ enterprise.deposit_model (clear link) ───────────────
alter table geo.deposit_style add column if not exists deposit_model_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname='fk_deposit_style_model') then
    alter table geo.deposit_style add constraint fk_deposit_style_model
      foreign key (deposit_model_id) references enterprise.deposit_model(id) on delete set null;
  end if;
end $$;
-- Backfill by shared code where deposit_model is seeded (no-op while it is empty).
update geo.deposit_style ds set deposit_model_id = dm.id
  from enterprise.deposit_model dm where ds.code = dm.code and ds.deposit_model_id is null;
create index if not exists idx_deposit_style_model_id on geo.deposit_style (deposit_model_id);

-- ── VERIFY (CI/CD) — expect: gk_fk=6, deposit_style_fk=1, unmapped keys reported ──
--   -- structural:
--   select
--     (select count(*) from pg_constraint where conname like 'fk_gk_%') as gk_fk,          -- expect 6
--     (select count(*) from pg_constraint where conname='fk_deposit_style_model') as ds_fk; -- expect 1
--   -- backfill health (per dimension: keys set vs ids mapped vs unmapped):
--   select 'commodity' dim,
--     count(*) filter (where commodity_key is not null) keys,
--     count(*) filter (where commodity_id is not null) mapped,
--     count(*) filter (where commodity_key is not null and commodity_id is null) unmapped
--     from geo.geological_knowledge
--   union all select 'deposit_style', count(*) filter (where deposit_style_key is not null),
--     count(*) filter (where deposit_style_id is not null),
--     count(*) filter (where deposit_style_key is not null and deposit_style_id is null) from geo.geological_knowledge;
--   -- (repeat for host_rock/lithology/formation/tectonic_setting)

-- ── ROLLBACK (down-path — drops only what this migration added) ─────────────
--   alter table geo.deposit_style drop constraint if exists fk_deposit_style_model;
--   drop index if exists geo.idx_deposit_style_model_id;
--   alter table geo.deposit_style drop column if exists deposit_model_id;
--   drop index if exists geo.idx_gk_commodity_id, geo.idx_gk_deposit_style_id, geo.idx_gk_host_rock_id,
--     geo.idx_gk_lithology_id, geo.idx_gk_formation_id, geo.idx_gk_tectonic_setting_id;
--   alter table geo.geological_knowledge
--     drop constraint if exists fk_gk_commodity, drop constraint if exists fk_gk_deposit_style,
--     drop constraint if exists fk_gk_host_rock, drop constraint if exists fk_gk_lithology,
--     drop constraint if exists fk_gk_formation, drop constraint if exists fk_gk_tectonic_setting;
--   alter table geo.geological_knowledge
--     drop column if exists commodity_id, drop column if exists deposit_style_id,
--     drop column if exists host_rock_id, drop column if exists lithology_id,
--     drop column if exists formation_id, drop column if exists tectonic_setting_id;

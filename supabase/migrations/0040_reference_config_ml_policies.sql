-- 0040_reference_config_ml_policies.sql
--
-- Luul Scan Enterprise — Phase 1, Sprint 3 (8/N, SECURITY): policies for the
-- reference/lookup data, config, feature flags, registries, and the ml
-- placeholder tables.
--
-- Security only (SELECT policies + grants) — NO schema DDL. Writes on all of
-- these are SERVICE-ROLE-ONLY (managed via seed/admin Edge Functions). Frozen
-- schema (0018-0032), public/consumer, production untouched. Reuses is_admin
-- (0034). Idempotent.
--
-- Read model:
--   * Reference data (taxonomy*, geologic_time, deposit_model, evidence_tier,
--     feature_flag, sensor_type, geo.raster_layer_registry): readable by any
--     authenticated user.
--   * Sensitive/internal (config_entry, data_version, ml.*): readable by admins
--     only (is_admin); otherwise service-role via BYPASSRLS.

-- ── Schema USAGE for authenticated on geo/ml (enterprise granted in 0034) ───
grant usage on schema geo, ml to authenticated;

-- ── Grants ─────────────────────────────────────────────────────────────────
-- Reference tables: SELECT to authenticated; full to service_role.
grant select on
  enterprise.taxonomy, enterprise.taxonomy_version, enterprise.taxonomy_node,
  enterprise.taxonomy_alias, enterprise.geologic_time, enterprise.deposit_model,
  enterprise.evidence_tier, enterprise.feature_flag, enterprise.sensor_type,
  geo.raster_layer_registry
  to authenticated;
grant select, insert, update, delete on
  enterprise.taxonomy, enterprise.taxonomy_version, enterprise.taxonomy_node,
  enterprise.taxonomy_alias, enterprise.geologic_time, enterprise.deposit_model,
  enterprise.evidence_tier, enterprise.feature_flag, enterprise.sensor_type,
  geo.raster_layer_registry
  to service_role;

-- Admin/internal tables: SELECT to authenticated (RLS => admin only); full to service_role.
grant select on
  enterprise.config_entry, enterprise.data_version, ml.ml_feature, ml.ml_model, ml.ml_score
  to authenticated;
grant select, insert, update, delete on
  enterprise.config_entry, enterprise.data_version, ml.ml_feature, ml.ml_model, ml.ml_score
  to service_role;

-- ── Reference SELECT policies (readable by all authenticated) ──────────────
drop policy if exists taxonomy_select on enterprise.taxonomy;
create policy taxonomy_select on enterprise.taxonomy for select to authenticated using (true);
drop policy if exists taxonomy_version_select on enterprise.taxonomy_version;
create policy taxonomy_version_select on enterprise.taxonomy_version for select to authenticated using (true);
drop policy if exists taxonomy_node_select on enterprise.taxonomy_node;
create policy taxonomy_node_select on enterprise.taxonomy_node for select to authenticated using (true);
drop policy if exists taxonomy_alias_select on enterprise.taxonomy_alias;
create policy taxonomy_alias_select on enterprise.taxonomy_alias for select to authenticated using (true);
drop policy if exists geologic_time_select on enterprise.geologic_time;
create policy geologic_time_select on enterprise.geologic_time for select to authenticated using (true);
drop policy if exists deposit_model_select on enterprise.deposit_model;
create policy deposit_model_select on enterprise.deposit_model for select to authenticated using (true);
drop policy if exists evidence_tier_select on enterprise.evidence_tier;
create policy evidence_tier_select on enterprise.evidence_tier for select to authenticated using (true);
drop policy if exists feature_flag_select on enterprise.feature_flag;
create policy feature_flag_select on enterprise.feature_flag for select to authenticated using (true);
drop policy if exists sensor_type_select on enterprise.sensor_type;
create policy sensor_type_select on enterprise.sensor_type for select to authenticated using (true);
drop policy if exists raster_registry_select on geo.raster_layer_registry;
create policy raster_registry_select on geo.raster_layer_registry for select to authenticated using (true);

-- ── Admin/internal SELECT policies (admins only) ───────────────────────────
drop policy if exists config_entry_select on enterprise.config_entry;
create policy config_entry_select on enterprise.config_entry for select to authenticated using (enterprise.is_admin());
drop policy if exists data_version_select on enterprise.data_version;
create policy data_version_select on enterprise.data_version for select to authenticated using (enterprise.is_admin());
drop policy if exists ml_feature_select on ml.ml_feature;
create policy ml_feature_select on ml.ml_feature for select to authenticated using (enterprise.is_admin());
drop policy if exists ml_model_select on ml.ml_model;
create policy ml_model_select on ml.ml_model for select to authenticated using (enterprise.is_admin());
drop policy if exists ml_score_select on ml.ml_score;
create policy ml_score_select on ml.ml_score for select to authenticated using (enterprise.is_admin());

-- ── VERIFY (CI/CD) — expect: select_policies=15, write_policies=0 ───────────
--   select
--     (select count(*) from pg_policies where cmd='SELECT' and (
--        (schemaname='enterprise' and tablename in ('taxonomy','taxonomy_version','taxonomy_node','taxonomy_alias',
--          'geologic_time','deposit_model','evidence_tier','feature_flag','sensor_type','config_entry','data_version'))
--        or (schemaname='geo' and tablename='raster_layer_registry')
--        or (schemaname='ml' and tablename in ('ml_feature','ml_model','ml_score')))) as select_policies,
--     (select count(*) from pg_policies where cmd in ('INSERT','UPDATE','DELETE','ALL') and (
--        schemaname in ('geo','ml') or (schemaname='enterprise' and tablename in ('taxonomy','taxonomy_version',
--          'taxonomy_node','taxonomy_alias','geologic_time','deposit_model','evidence_tier','feature_flag',
--          'sensor_type','config_entry','data_version')))) as write_policies; -- expect 0

-- ── ROLLBACK (down-path) ───────────────────────────────────────────────────
--   drop policy if exists ml_score_select on ml.ml_score;
--   drop policy if exists ml_model_select on ml.ml_model;
--   drop policy if exists ml_feature_select on ml.ml_feature;
--   drop policy if exists data_version_select on enterprise.data_version;
--   drop policy if exists config_entry_select on enterprise.config_entry;
--   drop policy if exists raster_registry_select on geo.raster_layer_registry;
--   drop policy if exists sensor_type_select on enterprise.sensor_type;
--   drop policy if exists feature_flag_select on enterprise.feature_flag;
--   drop policy if exists evidence_tier_select on enterprise.evidence_tier;
--   drop policy if exists deposit_model_select on enterprise.deposit_model;
--   drop policy if exists geologic_time_select on enterprise.geologic_time;
--   drop policy if exists taxonomy_alias_select on enterprise.taxonomy_alias;
--   drop policy if exists taxonomy_node_select on enterprise.taxonomy_node;
--   drop policy if exists taxonomy_version_select on enterprise.taxonomy_version;
--   drop policy if exists taxonomy_select on enterprise.taxonomy;
--   revoke select,insert,update,delete on enterprise.config_entry, enterprise.data_version, ml.ml_feature, ml.ml_model, ml.ml_score from service_role;
--   revoke select on enterprise.config_entry, enterprise.data_version, ml.ml_feature, ml.ml_model, ml.ml_score from authenticated;
--   revoke select,insert,update,delete on enterprise.taxonomy, enterprise.taxonomy_version, enterprise.taxonomy_node, enterprise.taxonomy_alias, enterprise.geologic_time, enterprise.deposit_model, enterprise.evidence_tier, enterprise.feature_flag, enterprise.sensor_type, geo.raster_layer_registry from service_role;
--   revoke select on enterprise.taxonomy, enterprise.taxonomy_version, enterprise.taxonomy_node, enterprise.taxonomy_alias, enterprise.geologic_time, enterprise.deposit_model, enterprise.evidence_tier, enterprise.feature_flag, enterprise.sensor_type, geo.raster_layer_registry from authenticated;
--   revoke usage on schema geo, ml from authenticated;

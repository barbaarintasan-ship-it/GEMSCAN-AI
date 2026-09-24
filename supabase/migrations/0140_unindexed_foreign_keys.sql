-- 0140_unindexed_foreign_keys.sql
--
-- Adds a covering index for every foreign key the Supabase performance
-- advisor flagged as unindexed across enterprise/geo/public (53 findings).
-- An unindexed FK forces a sequential scan of the CHILD table on every
-- parent-row delete/update (to check for orphans) and on every application
-- query that joins/filters on that column — several of these (sample.*,
-- expedition.*, exploration_mission.*, field_observation*.*, survey_track.*)
-- are read on every list/detail call in the app. Purely additive — no
-- behavior change, just a data structure Postgres can now choose to use.

create index if not exists idx_conflict_log_resolved_by on enterprise.conflict_log (resolved_by);
create index if not exists idx_custody_signature_signer_id on enterprise.custody_signature (signer_id);
create index if not exists idx_event_actor_id on enterprise.event (actor_id);
create index if not exists idx_event_organization_id on enterprise.event (organization_id);
create index if not exists idx_expedition_area_id on enterprise.expedition (area_id);
create index if not exists idx_expedition_mission_id on enterprise.expedition (mission_id);
create index if not exists idx_exploration_area_created_by on enterprise.exploration_area (created_by);
create index if not exists idx_exploration_area_creator_id on enterprise.exploration_area (creator_id);
create index if not exists idx_exploration_mission_created_by on enterprise.exploration_mission (created_by);
create index if not exists idx_exploration_mission_owner_id on enterprise.exploration_mission (owner_id);
create index if not exists idx_field_observation_area_id on enterprise.field_observation (area_id);
create index if not exists idx_field_observation_contributor_id on enterprise.field_observation (contributor_id);
create index if not exists idx_field_observation_sample_id on enterprise.field_observation (sample_id);
create index if not exists idx_field_observation_point_contributor_id on enterprise.field_observation_point (contributor_id);
create index if not exists idx_field_observation_point_sample_id on enterprise.field_observation_point (sample_id);
create index if not exists idx_field_observation_point_survey_track_id on enterprise.field_observation_point (survey_track_id);
create index if not exists idx_notification_event_id on enterprise.notification (event_id);
create index if not exists idx_occurrence_evidence_verified_by on enterprise.occurrence_evidence (verified_by);
create index if not exists idx_organization_created_by on enterprise.organization (created_by);
create index if not exists idx_project_created_by on enterprise.project (created_by);
create index if not exists idx_sample_formation_id on enterprise.sample (formation_id);
create index if not exists idx_sample_chain_event_actor_id on enterprise.sample_chain_event (actor_id);
create index if not exists idx_sample_chain_event_container_id on enterprise.sample_chain_event (container_id);
create index if not exists idx_sample_container_sealed_by on enterprise.sample_container (sealed_by);
create index if not exists idx_sample_discussion_author_id on enterprise.sample_discussion (author_id);
create index if not exists idx_sample_review_reviewer_id on enterprise.sample_review (reviewer_id);
create index if not exists idx_sample_revision_edited_by on enterprise.sample_revision (edited_by);
create index if not exists idx_sensor_sensor_type_id on enterprise.sensor (sensor_type_id);
create index if not exists idx_sensor_capture_area_id on enterprise.sensor_capture (area_id);
create index if not exists idx_sensor_capture_sample_id on enterprise.sensor_capture (sample_id);
create index if not exists idx_survey_track_expedition_id on enterprise.survey_track (expedition_id);
create index if not exists idx_survey_track_mission_id on enterprise.survey_track (mission_id);
create index if not exists idx_taxonomy_node_parent_id on enterprise.taxonomy_node (parent_id);
create index if not exists idx_assessment_conclusion_reviewed_by on geo.assessment_conclusion (reviewed_by);
create index if not exists idx_evidence_photo_user_id on geo.evidence_photo (user_id);
create index if not exists idx_geo_knowledge_rule_commodity_code on geo.geo_knowledge_rule (commodity_code);
create index if not exists idx_gis_layer_status_dataset_id on geo.gis_layer_status (dataset_id);
create index if not exists idx_mineral_assemblage_rule_commodity_code on geo.mineral_assemblage_rule (commodity_code);
create index if not exists idx_mineral_occurrence_deposit_style_id on geo.mineral_occurrence (deposit_style_id);
create index if not exists idx_mineral_occurrence_source_id on geo.mineral_occurrence (source_id);
create index if not exists idx_mission_package_user_id on geo.mission_package (user_id);
create index if not exists idx_mission_report_package_id on geo.mission_report (package_id);
create index if not exists idx_mission_report_user_id on geo.mission_report (user_id);
create index if not exists idx_structural_feature_dataset_id on geo.structural_feature (dataset_id);
create index if not exists idx_artifact_report_purchases_scan_id on public.artifact_report_purchases (scan_id);
create index if not exists idx_artifact_verification_verdicts_scan_id on public.artifact_verification_verdicts (scan_id);
create index if not exists idx_diamond_verification_verdicts_scan_id on public.diamond_verification_verdicts (scan_id);
create index if not exists idx_gold_report_purchases_scan_id on public.gold_report_purchases (scan_id);
create index if not exists idx_gold_verification_verdicts_scan_id on public.gold_verification_verdicts (scan_id);
create index if not exists idx_high_value_report_purchases_scan_id on public.high_value_report_purchases (scan_id);
create index if not exists idx_payment_events_user_id on public.payment_events (user_id);
create index if not exists idx_scan_feedback_user_id on public.scan_feedback (user_id);
create index if not exists idx_scan_usage_scan_id on public.scan_usage (scan_id);

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   -- Supabase's performance advisor (unindexed_foreign_keys) should report
--   -- zero findings for enterprise/geo/public after this migration.

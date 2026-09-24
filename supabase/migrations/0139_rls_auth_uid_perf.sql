-- 0139_rls_auth_uid_perf.sql
--
-- Applies the same RLS performance rewrite 0135 already applied to
-- enterprise.sample_structured_evidence to every OTHER policy still using a
-- bare `auth.uid()` in USING/WITH CHECK. Postgres re-evaluates a bare
-- `auth.uid()` call once PER ROW being checked; wrapped as a scalar subquery
-- `(select auth.uid())`, the planner evaluates it once per statement
-- (InitPlan) instead. Purely a performance rewrite — every condition below
-- is copied verbatim from the live policy definitions (pg_policies), with
-- ONLY `auth.uid()` -> `(select auth.uid())` changed. No access-control
-- semantics change.
--
-- Highest-traffic first: sample/expedition/survey_track are read on every
-- list/detail call in the app.

-- enterprise.sample — read on every "My Samples" list + every sample detail view.
drop policy if exists sample_select on enterprise.sample;
create policy sample_select on enterprise.sample for select using (
  (collector_id = (select auth.uid()))
  or (
    status = any (array['community_confirmed','expert_verified','lab_verified']::enterprise.sample_status[])
    and enterprise.can_read_area(area_id)
  )
  or (
    enterprise.is_reviewer()
    and status = any (array['submitted','ai_processing','ai_completed','awaiting_review','verified','needs_more_data','rejected','held']::enterprise.sample_status[])
  )
);

-- enterprise.expedition / expedition_track / field_observation — the field-sync tables.
drop policy if exists p_expedition_own on enterprise.expedition;
create policy p_expedition_own on enterprise.expedition for all
  using (created_by = (select auth.uid()))
  with check (created_by = (select auth.uid()));

drop policy if exists p_expedition_track_own on enterprise.expedition_track;
create policy p_expedition_track_own on enterprise.expedition_track for all
  using (exists (select 1 from enterprise.expedition e where e.id = expedition_track.expedition_id and e.created_by = (select auth.uid())))
  with check (exists (select 1 from enterprise.expedition e where e.id = expedition_track.expedition_id and e.created_by = (select auth.uid())));

drop policy if exists p_field_obs_own on enterprise.field_observation;
create policy p_field_obs_own on enterprise.field_observation for all
  using (exists (select 1 from enterprise.expedition e where e.id = field_observation.expedition_id and e.created_by = (select auth.uid())))
  with check (exists (select 1 from enterprise.expedition e where e.id = field_observation.expedition_id and e.created_by = (select auth.uid())));

drop policy if exists survey_track_select on enterprise.survey_track;
create policy survey_track_select on enterprise.survey_track for select using (
  (contributor_id = (select auth.uid())) or enterprise.can_read_area(area_id)
);

drop policy if exists fop_select on enterprise.field_observation_point;
create policy fop_select on enterprise.field_observation_point for select using (
  (contributor_id = (select auth.uid())) or enterprise.can_read_area(area_id)
);

-- enterprise.field_contributor
drop policy if exists fc_select on enterprise.field_contributor;
create policy fc_select on enterprise.field_contributor for select using (
  (user_id = (select auth.uid())) or enterprise.is_admin()
);
drop policy if exists fc_update on enterprise.field_contributor;
create policy fc_update on enterprise.field_contributor for update
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- enterprise.area_membership / custody_signature / sample_chain_event
drop policy if exists area_membership_select on enterprise.area_membership;
create policy area_membership_select on enterprise.area_membership for select using (
  (user_id = (select auth.uid())) or enterprise.is_area_manager(area_id)
);

drop policy if exists custody_sig_select on enterprise.custody_signature;
create policy custody_sig_select on enterprise.custody_signature for select using (
  (signer_id = (select auth.uid())) or enterprise.can_read_chain_event(chain_event_id)
);

drop policy if exists chain_event_select on enterprise.sample_chain_event;
create policy chain_event_select on enterprise.sample_chain_event for select using (
  (actor_id = (select auth.uid())) or enterprise.can_read_sample(sample_id)
);

-- enterprise.event / notification / notification_subscription
drop policy if exists event_select on enterprise.event;
create policy event_select on enterprise.event for select using (
  (actor_id = (select auth.uid())) or (organization_id is not null and enterprise.is_org_member(organization_id))
);

drop policy if exists notification_select on enterprise.notification;
create policy notification_select on enterprise.notification for select using (user_id = (select auth.uid()));

drop policy if exists notif_sub_select on enterprise.notification_subscription;
create policy notif_sub_select on enterprise.notification_subscription for select using (user_id = (select auth.uid()));
drop policy if exists notif_sub_update on enterprise.notification_subscription;
create policy notif_sub_update on enterprise.notification_subscription for update
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
drop policy if exists notif_sub_delete on enterprise.notification_subscription;
create policy notif_sub_delete on enterprise.notification_subscription for delete using (user_id = (select auth.uid()));

-- enterprise.project
drop policy if exists project_update on enterprise.project;
create policy project_update on enterprise.project for update
  using (
    (organization_id is null and owner_id = (select auth.uid()))
    or enterprise.org_role_of(organization_id) = any (array['owner','admin']::enterprise.org_role[])
  )
  with check (
    (organization_id is null and owner_id = (select auth.uid()))
    or enterprise.org_role_of(organization_id) = any (array['owner','admin']::enterprise.org_role[])
  );
drop policy if exists project_delete on enterprise.project;
create policy project_delete on enterprise.project for delete using (
  (organization_id is null and owner_id = (select auth.uid()))
  or enterprise.org_role_of(organization_id) = any (array['owner','admin']::enterprise.org_role[])
);

-- geo.* — Solo's own mission-package/report tables.
drop policy if exists "own photos" on geo.evidence_photo;
create policy "own photos" on geo.evidence_photo for select using ((select auth.uid()) = user_id);

drop policy if exists "own missions" on geo.field_mission;
create policy "own missions" on geo.field_mission for select using ((select auth.uid()) = user_id);

drop policy if exists "own packages" on geo.mission_package;
create policy "own packages" on geo.mission_package for select using ((select auth.uid()) = user_id);

drop policy if exists "own reports" on geo.mission_report;
create policy "own reports" on geo.mission_report for select using ((select auth.uid()) = user_id);

-- ── VERIFY ──────────────────────────────────────────────────────────────────
-- This list was generated by querying pg_policies for every enterprise/geo
-- policy with an unwrapped auth.uid() — the query below should return ZERO
-- rows once this migration is applied. NOTE: Postgres normalizes
-- `(select auth.uid())` to `( SELECT auth.uid() AS uid)` in pg_policies, so
-- match on `select auth.uid()` (case-insensitive), not the literal input text.
--   select schemaname, tablename, policyname from pg_policies
--   where schemaname in ('enterprise','geo')
--     and (qual ilike '%auth.uid()%' or with_check ilike '%auth.uid()%')
--     and qual not ilike '%select auth.uid()%'
--     and (with_check is null or with_check not ilike '%select auth.uid()%');

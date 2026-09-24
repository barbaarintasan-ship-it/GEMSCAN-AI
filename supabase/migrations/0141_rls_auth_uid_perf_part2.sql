-- 0141_rls_auth_uid_perf_part2.sql
--
-- 0139 fixed every SELECT/UPDATE/DELETE policy with an unwrapped auth.uid(),
-- but its own discovery query had a bug: `qual not ilike '%(select auth.uid())%'`
-- evaluates to NULL (not true) for INSERT-only policies, which always have
-- qual = NULL — so every INSERT policy was silently skipped. Confirmed by
-- re-running the actual Supabase performance advisor after 0139: 36 policies
-- still flagged, all INSERT (with_check-only) policies across enterprise,
-- public (the Solo/consumer scan app) and storage.objects.
--
-- Same rule as 0135/0139: every condition below is copied verbatim from the
-- live policy definitions (pg_policies), with ONLY auth.uid() ->
-- (select auth.uid()) changed. No access-control semantics change.

-- ── enterprise (the 5 INSERT policies 0139's query missed) ──────────────────

drop policy if exists area_insert on enterprise.exploration_area;
create policy area_insert on enterprise.exploration_area for insert with check (
  (creator_id = (select auth.uid())) and (project_id is null or enterprise.is_project_member(project_id))
);

drop policy if exists notif_sub_insert on enterprise.notification_subscription;
create policy notif_sub_insert on enterprise.notification_subscription for insert with check (
  user_id = (select auth.uid())
);

drop policy if exists org_insert on enterprise.organization;
create policy org_insert on enterprise.organization for insert with check (
  created_by = (select auth.uid())
);

drop policy if exists project_insert on enterprise.project;
create policy project_insert on enterprise.project for insert with check (
  (created_by = (select auth.uid()))
  and (organization_id is null or enterprise.org_role_of(organization_id) = any (array['owner','admin']::enterprise.org_role[]))
);

drop policy if exists sample_discussion_insert on enterprise.sample_discussion;
create policy sample_discussion_insert on enterprise.sample_discussion for insert with check (
  (author_id = (select auth.uid())) and enterprise.can_read_sample(sample_id)
);

-- ── public (Solo/consumer scan app) ──────────────────────────────────────────

drop policy if exists artifact_report_purchases_select_own on public.artifact_report_purchases;
create policy artifact_report_purchases_select_own on public.artifact_report_purchases for select using (
  (select auth.uid()) = user_id
);
drop policy if exists artifact_report_purchases_insert_own on public.artifact_report_purchases;
create policy artifact_report_purchases_insert_own on public.artifact_report_purchases for insert with check (
  ((select auth.uid()) = user_id) and (status = 'pending'::text) and (external_reference_id is null)
  and exists (select 1 from public.artifact_verifications where artifact_verifications.id = artifact_report_purchases.verification_id and artifact_verifications.user_id = (select auth.uid()))
);

drop policy if exists artifact_verification_verdicts_select_own on public.artifact_verification_verdicts;
create policy artifact_verification_verdicts_select_own on public.artifact_verification_verdicts for select using (
  exists (select 1 from public.scans where scans.id = artifact_verification_verdicts.scan_id and scans.user_id = (select auth.uid()))
);

drop policy if exists artifact_verifications_select_own on public.artifact_verifications;
create policy artifact_verifications_select_own on public.artifact_verifications for select using (
  (select auth.uid()) = user_id
);
drop policy if exists artifact_verifications_insert_own on public.artifact_verifications;
create policy artifact_verifications_insert_own on public.artifact_verifications for insert with check (
  ((select auth.uid()) = user_id)
  and exists (select 1 from public.scans where scans.id = artifact_verifications.scan_id and scans.user_id = (select auth.uid()))
);
drop policy if exists artifact_verifications_update_own on public.artifact_verifications;
create policy artifact_verifications_update_own on public.artifact_verifications for update
  using ((select auth.uid()) = user_id)
  with check (
    ((select auth.uid()) = user_id)
    and exists (select 1 from public.scans where scans.id = artifact_verifications.scan_id and scans.user_id = (select auth.uid()))
  );

drop policy if exists deep_scan_credits_select_own on public.deep_scan_credits;
create policy deep_scan_credits_select_own on public.deep_scan_credits for select using (
  (select auth.uid()) = user_id
);

drop policy if exists diamond_verification_verdicts_select_own on public.diamond_verification_verdicts;
create policy diamond_verification_verdicts_select_own on public.diamond_verification_verdicts for select using (
  exists (select 1 from public.scans where scans.id = diamond_verification_verdicts.scan_id and scans.user_id = (select auth.uid()))
);

drop policy if exists diamond_verifications_select_own on public.diamond_verifications;
create policy diamond_verifications_select_own on public.diamond_verifications for select using (
  (select auth.uid()) = user_id
);
drop policy if exists diamond_verifications_insert_own on public.diamond_verifications;
create policy diamond_verifications_insert_own on public.diamond_verifications for insert with check (
  ((select auth.uid()) = user_id)
  and exists (select 1 from public.scans where scans.id = diamond_verifications.scan_id and scans.user_id = (select auth.uid()))
);
drop policy if exists diamond_verifications_update_own on public.diamond_verifications;
create policy diamond_verifications_update_own on public.diamond_verifications for update
  using ((select auth.uid()) = user_id)
  with check (
    ((select auth.uid()) = user_id)
    and exists (select 1 from public.scans where scans.id = diamond_verifications.scan_id and scans.user_id = (select auth.uid()))
  );

drop policy if exists gold_report_purchases_select_own on public.gold_report_purchases;
create policy gold_report_purchases_select_own on public.gold_report_purchases for select using (
  (select auth.uid()) = user_id
);
drop policy if exists gold_report_purchases_insert_own on public.gold_report_purchases;
create policy gold_report_purchases_insert_own on public.gold_report_purchases for insert with check (
  ((select auth.uid()) = user_id) and (status = 'pending'::text) and (external_reference_id is null)
  and exists (select 1 from public.gold_verifications where gold_verifications.id = gold_report_purchases.verification_id and gold_verifications.user_id = (select auth.uid()))
);

drop policy if exists gold_verification_verdicts_select_own on public.gold_verification_verdicts;
create policy gold_verification_verdicts_select_own on public.gold_verification_verdicts for select using (
  exists (select 1 from public.scans where scans.id = gold_verification_verdicts.scan_id and scans.user_id = (select auth.uid()))
);

drop policy if exists gold_verifications_select_own on public.gold_verifications;
create policy gold_verifications_select_own on public.gold_verifications for select using (
  (select auth.uid()) = user_id
);
drop policy if exists gold_verifications_insert_own on public.gold_verifications;
create policy gold_verifications_insert_own on public.gold_verifications for insert with check (
  ((select auth.uid()) = user_id)
  and exists (select 1 from public.scans where scans.id = gold_verifications.scan_id and scans.user_id = (select auth.uid()))
);
drop policy if exists gold_verifications_update_own on public.gold_verifications;
create policy gold_verifications_update_own on public.gold_verifications for update
  using ((select auth.uid()) = user_id)
  with check (
    ((select auth.uid()) = user_id)
    and exists (select 1 from public.scans where scans.id = gold_verifications.scan_id and scans.user_id = (select auth.uid()))
  );

drop policy if exists high_value_report_purchases_select_own on public.high_value_report_purchases;
create policy high_value_report_purchases_select_own on public.high_value_report_purchases for select using (
  (select auth.uid()) = user_id
);
drop policy if exists high_value_report_purchases_insert_own on public.high_value_report_purchases;
create policy high_value_report_purchases_insert_own on public.high_value_report_purchases for insert with check (
  ((select auth.uid()) = user_id) and (status = 'pending'::text) and (external_reference_id is null)
  and exists (select 1 from public.diamond_verifications where diamond_verifications.id = high_value_report_purchases.verification_id and diamond_verifications.user_id = (select auth.uid()))
);

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles for select using ((select auth.uid()) = id);
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update using ((select auth.uid()) = id);

drop policy if exists scan_ai_responses_select_own on public.scan_ai_responses;
create policy scan_ai_responses_select_own on public.scan_ai_responses for select using (
  exists (select 1 from public.scans where scans.id = scan_ai_responses.scan_id and scans.user_id = (select auth.uid()))
);

drop policy if exists scan_candidates_select_own on public.scan_candidates;
create policy scan_candidates_select_own on public.scan_candidates for select using (
  exists (select 1 from public.scans where scans.id = scan_candidates.scan_id and scans.user_id = (select auth.uid()))
);

drop policy if exists scan_feedback_select_own on public.scan_feedback;
create policy scan_feedback_select_own on public.scan_feedback for select using (
  (select auth.uid()) = user_id
);
drop policy if exists scan_feedback_insert_own on public.scan_feedback;
create policy scan_feedback_insert_own on public.scan_feedback for insert with check (
  ((select auth.uid()) = user_id)
  and exists (select 1 from public.scans where scans.id = scan_feedback.scan_id and scans.user_id = (select auth.uid()))
);

drop policy if exists scan_images_select_own on public.scan_images;
create policy scan_images_select_own on public.scan_images for select using (
  exists (select 1 from public.scans where scans.id = scan_images.scan_id and scans.user_id = (select auth.uid()))
);
drop policy if exists scan_images_insert_own on public.scan_images;
create policy scan_images_insert_own on public.scan_images for insert with check (
  exists (select 1 from public.scans where scans.id = scan_images.scan_id and scans.user_id = (select auth.uid()))
);

drop policy if exists scan_usage_select_own on public.scan_usage;
create policy scan_usage_select_own on public.scan_usage for select using ((select auth.uid()) = user_id);

drop policy if exists scans_select_own on public.scans;
create policy scans_select_own on public.scans for select using ((select auth.uid()) = user_id);
drop policy if exists scans_insert_own on public.scans;
create policy scans_insert_own on public.scans for insert with check ((select auth.uid()) = user_id);

drop policy if exists subscriptions_select_own on public.subscriptions;
create policy subscriptions_select_own on public.subscriptions for select using ((select auth.uid()) = user_id);

-- ── storage.objects (the scan-images bucket's own-folder policies) ─────────

drop policy if exists "scan_images_storage_select_own" on storage.objects;
create policy "scan_images_storage_select_own" on storage.objects for select using (
  (bucket_id = 'scan-images'::text) and ((storage.foldername(name))[1] = ((select auth.uid()))::text)
);
drop policy if exists "scan_images_storage_insert_own" on storage.objects;
create policy "scan_images_storage_insert_own" on storage.objects for insert with check (
  (bucket_id = 'scan-images'::text) and ((storage.foldername(name))[1] = ((select auth.uid()))::text)
);

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select schemaname, tablename, policyname from pg_policies
--   where (coalesce(qual,'') ilike '%auth.uid()%' or coalesce(with_check,'') ilike '%auth.uid()%')
--     and coalesce(qual,'') not ilike '%select auth.uid()%'
--     and coalesce(with_check,'') not ilike '%select auth.uid()%';
--   -- should return zero rows.

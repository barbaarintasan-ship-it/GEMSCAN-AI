-- 0081_reviewer_storage_read.sql
--
-- Review Console S4 — a geologist reviewing a sample must be able to SEE its photos.
-- Enterprise sample media lives in the shared `scan-images` bucket, namespaced under
-- `{collectorId}/enterprise/...` (see enterpriseSamples.uploadSampleMedia). The base
-- storage policy (0002) only lets the OWNER of the first path segment read an object,
-- so a reviewer (a different user) can't sign URLs for a collector's photos.
--
-- Add a narrowly-scoped SELECT policy: an active reviewer (enterprise.is_reviewer(),
-- from 0079) may read scan-images objects ONLY when the second path segment is
-- 'enterprise'. That covers enterprise sample media and nothing else — consumer scan
-- photos are stored as `{userId}/{scanId}/...` (segment 2 is a scan id, never the
-- literal 'enterprise'), so they stay private. Read-only; no insert/update/delete.

create policy "scan_images_storage_select_reviewer_enterprise"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'scan-images'
    and (storage.foldername(name))[2] = 'enterprise'
    and enterprise.is_reviewer()
  );

-- ── VERIFY ── policy present; a reviewer can read an enterprise-namespaced object ──
--   select count(*) from pg_policies
--     where schemaname='storage' and tablename='objects'
--       and policyname='scan_images_storage_select_reviewer_enterprise';  -- 1

-- ── ROLLBACK ──
--   drop policy if exists "scan_images_storage_select_reviewer_enterprise" on storage.objects;

-- 0016: align app_config with the build-number update check the app uses.
--
-- Production's app_config still had the older version-STRING schema
-- (latest_version / min_version), but the mobile app queries the integer
-- build-number columns (latest_build / min_build). That mismatch made the
-- PostgREST query error, so checkForUpdate() returned null and Settings
-- silently reported "up to date" even when a newer build existed.
--
-- Add the integer build columns the app expects. The old string columns are
-- left in place (harmless, unused) to keep this non-destructive.

alter table public.app_config
  add column if not exists latest_build integer not null default 0,
  add column if not exists min_build integer not null default 0;

-- latest_build = the NEWEST build number (Android versionCode) published to the
-- store; anything below it gets a soft update prompt. min_build (0 = off) would
-- FORCE older builds to update. Keep latest_build in sync on every release.
update public.app_config
set latest_build = 31,
    min_build = 0,
    updated_at = now()
where id = 1;

-- Update-check target: bump latest_build to the newest published build (v37).
-- Anything below this gets a soft update prompt. min_build stays 0 (no forced
-- update). Keep this in sync with the newest build LIVE on the Play Store.

update public.app_config
set latest_build = 37,
    updated_at = now()
where id = 1;

-- app_config: a single-row table the mobile app reads on launch to decide
-- whether to prompt the user to update. The app compares its own Android
-- versionCode (the build number EAS auto-increments each build) with the values
-- here. After publishing a release, set latest_build to that build's number
-- (visible in EAS / Play Console). Set min_build only to FORCE older users to
-- update. Publicly readable (no secrets here); only service_role can write.

create table if not exists public.app_config (
  id                 smallint primary key default 1,
  -- Newest build number you have published (Android versionCode).
  latest_build       integer not null default 0,
  -- Oldest build still allowed to run. Users below this get a FORCED prompt
  -- (no "Later" button). Keep at 0 for soft prompts only.
  min_build          integer not null default 0,
  update_message_en  text not null default 'A new version of GemScan is available with improvements and fixes.',
  update_message_so  text not null default 'Nooc cusub oo GemScan ah ayaa diyaar ah oo leh horumar iyo hagaajin.',
  store_url          text not null default 'https://play.google.com/store/apps/details?id=com.gemscan.ai',
  updated_at         timestamptz not null default now(),
  constraint app_config_singleton check (id = 1)
);

insert into public.app_config (id) values (1) on conflict (id) do nothing;

alter table public.app_config enable row level security;

-- Read-only for everyone (anon + authenticated).
drop policy if exists "app_config_public_read" on public.app_config;
create policy "app_config_public_read"
  on public.app_config for select
  to anon, authenticated
  using (true);

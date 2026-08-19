-- Single active session per account (one phone at a time).
--
-- The mobile app writes a fresh random id here on each successful login and
-- remembers it locally. When it later reads a DIFFERENT id (because the same
-- account signed in on another phone), it signs itself out. This stops one
-- account from being used on several phones at once.
--
-- No new policy is needed: profiles already has RLS `profiles_select_own` and
-- `profiles_update_own` (migration 0001), so a user can only read/write the
-- session id on their OWN row and never see or claim anyone else's.

alter table public.profiles
  add column if not exists active_session_id text;

comment on column public.profiles.active_session_id is
  'Opaque id of the device that most recently signed in. The app signs itself '
  'out when this differs from its locally stored id (single-session enforcement).';

-- 0074_sample_discussion.sql
--
-- Review Console S1 — an internal discussion thread per sample (§ discussion), so
-- collectors and geologists communicate in-platform. Anyone who can read the
-- sample (collector, assigned geologists, org company users via can_read_sample)
-- can read and post. Append-only from the client's perspective (no edit/delete
-- policy); posts are attributed and timestamped.

create table if not exists enterprise.sample_discussion (
  id          uuid primary key default gen_random_uuid(),
  sample_id   uuid not null references enterprise.sample(id) on delete cascade,
  author_id   uuid references auth.users(id) on delete set null,
  author_role text,                                    -- role at time of posting (display)
  body        text not null,
  created_at  timestamptz not null default now(),
  constraint ck_discussion_body_nonempty check (length(btrim(body)) > 0)
);
create index if not exists idx_sample_discussion_sample
  on enterprise.sample_discussion(sample_id, created_at);

alter table enterprise.sample_discussion enable row level security;

-- Read: anyone who can read the parent sample.
drop policy if exists sample_discussion_select on enterprise.sample_discussion;
create policy sample_discussion_select on enterprise.sample_discussion for select to authenticated
  using (enterprise.can_read_sample(sample_id));

-- Post: an authenticated participant posts as themselves on a sample they can read.
drop policy if exists sample_discussion_insert on enterprise.sample_discussion;
create policy sample_discussion_insert on enterprise.sample_discussion for insert to authenticated
  with check (author_id = auth.uid() and enterprise.can_read_sample(sample_id));

grant select, insert on enterprise.sample_discussion to authenticated;
grant select, insert on enterprise.sample_discussion to service_role;

-- ── VERIFY — rls on, 2 policies, no update/delete grant ─────────────────────
--   select relrowsecurity from pg_class where oid='enterprise.sample_discussion'::regclass;  -- t
--   select count(*) from pg_policies where schemaname='enterprise' and tablename='sample_discussion'; -- 2
--   select has_table_privilege('authenticated','enterprise.sample_discussion','delete');      -- f

-- ── ROLLBACK ──
--   drop table if exists enterprise.sample_discussion;

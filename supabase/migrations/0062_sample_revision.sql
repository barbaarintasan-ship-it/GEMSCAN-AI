-- 0062_sample_revision.sql
--
-- Sprint 4.2.1 — append-only revision history for samples (§8, §12 "preserve
-- revision history"; §20 audit-history compatibility).
--
-- Every create/edit of a sample writes an immutable snapshot row here (done by
-- the service-role RPC, not the client). Readers see revisions for samples they
-- can already read (can_read_sample), so history follows the same RLS as the
-- sample itself. No client write grant — history cannot be forged or edited.

create table if not exists enterprise.sample_revision (
  id             uuid primary key default gen_random_uuid(),
  sample_id      uuid not null references enterprise.sample(id) on delete cascade,
  revision_no    integer not null,                 -- 1 = initial submission, then 2,3…
  edited_by      uuid references auth.users(id) on delete set null,
  change_summary text,                              -- short human note ("edited GPS + notes")
  snapshot       jsonb not null,                    -- full sample state at this revision
  created_at     timestamptz not null default now(),
  unique (sample_id, revision_no)
);

create index if not exists idx_sample_revision_sample
  on enterprise.sample_revision(sample_id, revision_no desc);

alter table enterprise.sample_revision enable row level security;

-- SELECT: same visibility as the parent sample. No INSERT/UPDATE/DELETE policy
-- for authenticated → writes are service-role only (append-only from the RPC).
drop policy if exists sample_revision_select on enterprise.sample_revision;
create policy sample_revision_select on enterprise.sample_revision for select to authenticated
  using (enterprise.can_read_sample(sample_id));

grant select on enterprise.sample_revision to authenticated;
grant select, insert on enterprise.sample_revision to service_role;

-- ── VERIFY — expect: rls=on, 1 select policy, auth has SELECT not INSERT ─────
--   select relrowsecurity from pg_class where oid = 'enterprise.sample_revision'::regclass; -- t
--   select count(*) from pg_policies where schemaname='enterprise' and tablename='sample_revision'; -- 1
--   select has_table_privilege('authenticated','enterprise.sample_revision','insert'); -- f
--   select has_table_privilege('authenticated','enterprise.sample_revision','select'); -- t

-- ── ROLLBACK ──
--   drop table if exists enterprise.sample_revision;

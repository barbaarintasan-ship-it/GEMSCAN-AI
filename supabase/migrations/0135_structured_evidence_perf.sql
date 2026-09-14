-- 0135_structured_evidence_perf.sql
--
-- Two performance-advisor findings from Phase 6 (0128), fixed before any
-- real traffic hits this table:
--   1. structured_evidence_insert re-evaluated auth.uid() per row instead of
--      once per statement — wrapping in (select auth.uid()) lets Postgres
--      evaluate it once (documented Supabase RLS performance pattern).
--      Same predicate, same behavior, just evaluated once.
--   2. sample_structured_evidence.created_by (FK to auth.users) had no
--      covering index.

drop policy if exists structured_evidence_insert on enterprise.sample_structured_evidence;
create policy structured_evidence_insert on enterprise.sample_structured_evidence
  for insert with check (
    created_by = (select auth.uid())
    and exists (
      select 1 from enterprise.sample s
      where s.id = sample_structured_evidence.sample_id and s.collector_id = (select auth.uid())
    )
  );

create index if not exists idx_structured_evidence_created_by on enterprise.sample_structured_evidence (created_by);

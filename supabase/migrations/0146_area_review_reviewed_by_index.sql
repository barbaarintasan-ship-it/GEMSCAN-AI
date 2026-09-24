-- 0146_area_review_reviewed_by_index.sql
--
-- Phase 11 follow-up: the Supabase performance advisor flagged
-- exploration_area_reviewed_by_fkey as an unindexed foreign key
-- immediately after 0144 added it. Same fix pattern as 0140
-- (unindexed_foreign_keys sweep) — one covering index, nothing else.

create index if not exists idx_exploration_area_reviewed_by on enterprise.exploration_area (reviewed_by);

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select indexname from pg_indexes where schemaname='enterprise'
--     and tablename='exploration_area' and indexname='idx_exploration_area_reviewed_by';

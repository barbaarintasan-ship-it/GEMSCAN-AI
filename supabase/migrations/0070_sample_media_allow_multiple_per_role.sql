-- 0070_sample_media_allow_multiple_per_role.sql
--
-- Bugfix: submissions failed with "duplicate key value violates unique constraint
-- uq_sample_media_role". That partial unique index (0023) allowed only ONE photo
-- per role (except 'extra'), but a real geological sample legitimately has several
-- close-up / detail photos, and the mobile app tags every non-first photo as
-- 'surface_closeup' — so two close-ups collided.
--
-- Drop the constraint: any number of photos per role is allowed. A plain index on
-- sample_id keeps look-ups fast (already created in 0023: idx_sample_media_sample).
-- Additive/relaxing only — nothing that inserted before can break.

drop index if exists enterprise.uq_sample_media_role;

-- ── VERIFY — the unique index is gone ───────────────────────────────────────
--   select count(*) from pg_indexes
--     where schemaname='enterprise' and indexname='uq_sample_media_role';   -- 0

-- ── ROLLBACK ──
--   create unique index if not exists uq_sample_media_role
--     on enterprise.sample_media (sample_id, role) where role <> 'extra';

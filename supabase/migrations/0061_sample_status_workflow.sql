-- 0061_sample_status_workflow.sql
--
-- Sprint 4.2.1 — extend enterprise.sample_status with the production field→review
-- lifecycle (§13):
--   draft → ready → uploading → ai_processing → ai_completed → awaiting_review
--        → verified | needs_more_data | rejected
--
-- ADD VALUE only (never remove) so existing rows/values stay valid. The prior
-- values (submitted, community_confirmed, expert_verified, lab_verified, held,
-- rejected) remain for back-compat; `rejected` already exists. New client/RPC
-- code drives the new states; old states are still readable.
--
-- Note: ALTER TYPE ... ADD VALUE runs fine on PG17 inside a migration as long as
-- the new label is not *used* in the same transaction — we only add labels here.

alter type enterprise.sample_status add value if not exists 'draft';
alter type enterprise.sample_status add value if not exists 'ready';
alter type enterprise.sample_status add value if not exists 'uploading';
alter type enterprise.sample_status add value if not exists 'ai_processing';
alter type enterprise.sample_status add value if not exists 'ai_completed';
alter type enterprise.sample_status add value if not exists 'awaiting_review';
alter type enterprise.sample_status add value if not exists 'verified';
alter type enterprise.sample_status add value if not exists 'needs_more_data';

-- ── VERIFY — expect the 8 new labels present ────────────────────────────────
--   select count(*) from unnest(enum_range(null::enterprise.sample_status)) v
--     where v::text in ('draft','ready','uploading','ai_processing','ai_completed',
--                       'awaiting_review','verified','needs_more_data');   -- = 8

-- ── ROLLBACK ──
--   Postgres cannot drop individual enum values. To revert, recreate the type
--   without these labels and re-cast the column (only safe if no row uses them).

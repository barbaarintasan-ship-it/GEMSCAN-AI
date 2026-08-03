-- 0083_enable_self_review_owner_beta.sql
--
-- Owner-beta: turn ON the `self_review` flag (added OFF in 0076) so the owner —
-- who is BOTH collector and reviewer during the private beta — can review their own
-- samples in the Review Console. Without this, review_sample raises
-- "Collector != Reviewer" and the console shows an error on every submit.
--
-- Still safe: the enforce_reviewer_not_collector trigger (0076) is double-gated —
-- even with this flag on, self-review is permitted ONLY for the owner-beta account
-- (awmusse.musse@gmail.com). Any other collector reviewing their own sample is still
-- rejected. MUST be set back to false before real multi-reviewer production.

update enterprise.feature_flag set default_enabled = true where key = 'self_review';

-- ── VERIFY ── flag on ───────────────────────────────────────────────────────
--   select default_enabled from enterprise.feature_flag where key='self_review';  -- t

-- ── ROLLBACK ──
--   update enterprise.feature_flag set default_enabled = false where key='self_review';

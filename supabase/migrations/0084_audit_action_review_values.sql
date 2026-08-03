-- 0084_audit_action_review_values.sql
--
-- Bug fix: the review_sample RPC (0078) writes audit rows with action values
-- 'review_draft' / 'review_verify' / 'review_needs_more_data' / 'review_reject',
-- but the enterprise.audit_action enum (0018) only had
-- insert|update|delete|verify|promote|login|export. So EVERY review submit failed
-- at the audit insert with `invalid input value for enum audit_action`, surfacing
-- as a 500 in the Review Console. Add the four review actions the RPC needs.
--
-- ADD VALUE only (never removes existing labels), so all existing audit rows stay
-- valid. Safe inside a migration on PG14+ as long as the new labels aren't USED in
-- the same transaction — they are only referenced later by the RPC at runtime.

alter type enterprise.audit_action add value if not exists 'review_draft';
alter type enterprise.audit_action add value if not exists 'review_verify';
alter type enterprise.audit_action add value if not exists 'review_needs_more_data';
alter type enterprise.audit_action add value if not exists 'review_reject';

-- ── VERIFY — expect the 4 new labels present ────────────────────────────────
--   select count(*) from unnest(enum_range(null::enterprise.audit_action)) v
--     where v::text in ('review_draft','review_verify','review_needs_more_data','review_reject'); -- = 4

-- ── ROLLBACK ──
--   Postgres cannot drop individual enum values; recreate the type without them
--   (only safe if no audit_log row uses them).

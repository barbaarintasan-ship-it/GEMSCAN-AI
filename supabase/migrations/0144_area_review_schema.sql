-- 0144_area_review_schema.sql
--
-- Phase 11 (Geological Intelligence Transformation) — schema for human
-- geological review of a mission's exploration_area. The Gap Audit found
-- exploration_area.status (area_status: new/community/verified/archived)
-- and verification_status (verification_state) both exist but are NEVER
-- written by any RPC today, and neither vocabulary is review-decision-
-- shaped — reusing/overloading either would collide with whatever they
-- were originally meant for. This migration adds a dedicated, minimal set
-- of columns instead, leaving both pre-existing columns untouched.
--
-- Mirrors the ALREADY-SHIPPED enterprise.sample_review / review_sample()
-- pattern (0077/0078) at the same size: a human reviewer records a
-- decision, who made it, and when — nothing more. No draft/round concept
-- (Phase 11's own spec lifecycle has no draft state, unlike sample
-- review), no new audit architecture (enterprise.audit_log's existing
-- before/after jsonb gives full review history for free, same as every
-- other reviewable entity in this codebase).
--
-- SPLIT FROM THE RPC MIGRATION ON PURPOSE: `alter type ... add value` must
-- be committed before the new label can be USED — see 0084's own header
-- note, which documents review_sample() shipping BROKEN because its enum
-- values landed in the same migration as first use. This migration adds
-- the enum values and columns only; 0145 adds the RPC that reads/writes
-- them, in its own later transaction.

alter type enterprise.audit_action add value if not exists 'area_review_accept';
alter type enterprise.audit_action add value if not exists 'area_review_reject';
alter type enterprise.audit_action add value if not exists 'area_review_needs_more_data';

create type enterprise.area_review_status as enum ('pending', 'accepted', 'rejected', 'needs_more_data');

alter table enterprise.exploration_area
  add column if not exists review_status enterprise.area_review_status not null default 'pending',
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_notes text,
  add column if not exists reviewer_role text;

comment on column enterprise.exploration_area.review_status is
  'Phase 11 — human geological review outcome. Independent of, and never derived from, prospectivity_score/evidence/reasons/coverage (Phase 10) or AI synthesis (Phase 7): the deterministic engine and AI remain non-authoritative for this column, and this column never feeds back into either. Re-reviewable — a manager may revise a decision later (e.g. after more field evidence arrives); every transition is audited, not just the latest value.';
comment on column enterprise.exploration_area.reviewed_by is 'Phase 11 — server-derived from auth.uid() at review time, never client-supplied.';
comment on column enterprise.exploration_area.reviewed_at is 'Phase 11 — server-derived from now() at review time, never client-supplied.';
comment on column enterprise.exploration_area.review_notes is 'Phase 11 — optional free-text geological rationale the reviewer supplies. Never parsed into scoring logic.';
comment on column enterprise.exploration_area.reviewer_role is 'Phase 11 — the reviewing contributor''s role at the time of review, captured for the audit record (same convention as sample_review.reviewer_role).';

create index if not exists idx_exploration_area_review_status on enterprise.exploration_area (review_status);

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select count(*) from unnest(enum_range(null::enterprise.audit_action)) v
--     where v::text in ('area_review_accept','area_review_reject','area_review_needs_more_data'); -- = 3
--   select column_name from information_schema.columns where table_schema='enterprise'
--     and table_name='exploration_area' and column_name in
--     ('review_status','reviewed_by','reviewed_at','review_notes','reviewer_role'); -- = 5 rows

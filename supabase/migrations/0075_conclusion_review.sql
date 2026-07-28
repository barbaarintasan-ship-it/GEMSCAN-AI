-- 0075_conclusion_review.sql
--
-- Review Console S1 — a geologist can confirm/correct each AI conclusion WITHOUT
-- overwriting the AI's original text (traceability, Principle: AI confidence/output
-- never destroyed). Corrections are additive columns on geo.assessment_conclusion.

alter table geo.assessment_conclusion
  add column if not exists review_state         text not null default 'pending',
  add column if not exists reviewed_by          uuid references auth.users(id) on delete set null,
  add column if not exists reviewed_at           timestamptz,
  add column if not exists corrected_statement    text,      -- geologist's replacement (English)
  add column if not exists corrected_statement_so text,      -- geologist's replacement (Somali)
  add column if not exists review_note            text;

do $$ begin
  alter table geo.assessment_conclusion add constraint ck_conclusion_review_state
    check (review_state in ('pending','confirmed','corrected','rejected'));
exception when duplicate_object then null; end $$;

-- ── VERIFY — columns present, default pending ───────────────────────────────
--   select count(*) from information_schema.columns where table_schema='geo'
--     and table_name='assessment_conclusion'
--     and column_name in ('review_state','reviewed_by','corrected_statement'); -- 3

-- ── ROLLBACK ──
--   alter table geo.assessment_conclusion
--     drop column if exists review_state, drop column if exists reviewed_by,
--     drop column if exists reviewed_at, drop column if exists corrected_statement,
--     drop column if exists corrected_statement_so, drop column if exists review_note;

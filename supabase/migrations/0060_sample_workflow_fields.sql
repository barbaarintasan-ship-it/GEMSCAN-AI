-- 0060_sample_workflow_fields.sql
--
-- Sprint 4.2.1 — extend enterprise.sample with human-facing workflow fields.
--   name                  human-friendly sample name (e.g. "Milxa Quartz Vein 01").
--                         The UUID stays internal; the UI always shows this name.
--   ai_confidence         AI model's confidence (0–100). NEVER overwritten by review.
--   geologist_confidence  reviewer's confidence (0–100), set later by a geologist.
--   completeness_score    0–100 field-data completeness (see §17), distinct from the
--                         existing coarse `completeness_status` enum.
--
-- Additive & backward compatible: `name` is added NULLABLE here so the currently
-- deployed mobile build keeps working; the submit_sample RPC will REQUIRE a name
-- once the updated client (which always sends one) ships in this same slice.
-- Existing owner-beta rows are backfilled with a friendly placeholder.

alter table enterprise.sample
  add column if not exists name                 text,
  add column if not exists ai_confidence        numeric(5,2),
  add column if not exists geologist_confidence numeric(5,2),
  add column if not exists completeness_score   numeric(5,2);

-- Backfill any pre-existing rows so the UI never shows a blank name.
update enterprise.sample
  set name = 'Sample ' || left(id::text, 8)
  where name is null;

-- Range / non-empty guards (idempotent).
do $$ begin
  alter table enterprise.sample add constraint ck_sample_name_nonempty
    check (name is null or length(btrim(name)) > 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table enterprise.sample add constraint ck_sample_ai_confidence
    check (ai_confidence is null or (ai_confidence >= 0 and ai_confidence <= 100));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table enterprise.sample add constraint ck_sample_geologist_confidence
    check (geologist_confidence is null or (geologist_confidence >= 0 and geologist_confidence <= 100));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table enterprise.sample add constraint ck_sample_completeness_score
    check (completeness_score is null or (completeness_score >= 0 and completeness_score <= 100));
exception when duplicate_object then null; end $$;

-- ── VERIFY — expect all 4 columns present, 0 null names ─────────────────────
--   select count(*) filter (where column_name in
--     ('name','ai_confidence','geologist_confidence','completeness_score')) as cols
--     from information_schema.columns where table_schema='enterprise' and table_name='sample';
--   -- cols = 4
--   select count(*) from enterprise.sample where name is null;  -- 0

-- ── ROLLBACK ──
--   alter table enterprise.sample
--     drop column if exists name, drop column if exists ai_confidence,
--     drop column if exists geologist_confidence, drop column if exists completeness_score;

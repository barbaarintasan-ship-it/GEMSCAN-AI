-- 0026_occurrence.sql
--
-- Luul Scan Enterprise — Phase 1, Sprint 2 (8/14): mineral-occurrence evidence,
-- the FK-backed verification tables (A2.3.2, replacing the polymorphic design),
-- and laboratory results.
--
-- Additive & isolated (enterprise). Idempotent. Depends on: 0018 (enums
-- evidence_type/verification_state/review_decision), 0019 (evidence_tier),
-- 0021 (exploration_area), 0023 (sample).
--
-- Note: "reviewer must not be the collector" (no self-verify) is enforced in the
-- Edge Function (submit-verification), not as a DB constraint.

-- ── Occurrence evidence (A1.3.2) ───────────────────────────────────────────
create table if not exists enterprise.occurrence_evidence (
  id                  uuid primary key default gen_random_uuid(),
  exploration_area_id uuid not null references enterprise.exploration_area(id) on delete cascade,
  sample_id           uuid references enterprise.sample(id) on delete set null,
  evidence_type       enterprise.evidence_type not null references enterprise.evidence_tier(evidence_type),
  description         text,
  source              text,
  confidence_score    numeric(5,2) not null default 0,
  verification_status enterprise.verification_state not null default 'unverified',
  verified_by         uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  constraint ck_occurrence_confidence check (confidence_score >= 0 and confidence_score <= 100)
);
create index if not exists idx_occurrence_area on enterprise.occurrence_evidence(exploration_area_id);
create index if not exists idx_occurrence_sample on enterprise.occurrence_evidence(sample_id);
create index if not exists idx_occurrence_type on enterprise.occurrence_evidence(evidence_type);
create index if not exists idx_occurrence_vstatus on enterprise.occurrence_evidence(verification_status);

-- ── Sample verification (A2.3.2 — FK-backed) ───────────────────────────────
create table if not exists enterprise.sample_verification (
  id          uuid primary key default gen_random_uuid(),
  sample_id   uuid not null references enterprise.sample(id) on delete cascade,
  reviewer_id uuid references auth.users(id) on delete set null,
  level       text not null,                             -- 'community' | 'expert'
  decision    enterprise.review_decision not null,
  weight      numeric(5,2) not null,
  note        text,
  created_at  timestamptz not null default now(),
  constraint uq_sample_verification unique (sample_id, reviewer_id, level)
);
create index if not exists idx_sample_verif_sample on enterprise.sample_verification(sample_id);
create index if not exists idx_sample_verif_reviewer on enterprise.sample_verification(reviewer_id);

-- ── Occurrence verification (A2.3.2 — FK-backed) ───────────────────────────
create table if not exists enterprise.occurrence_verification (
  id            uuid primary key default gen_random_uuid(),
  occurrence_id uuid not null references enterprise.occurrence_evidence(id) on delete cascade,
  reviewer_id   uuid references auth.users(id) on delete set null,
  level         text not null,
  decision      enterprise.review_decision not null,
  weight        numeric(5,2) not null,
  note          text,
  created_at    timestamptz not null default now(),
  constraint uq_occurrence_verification unique (occurrence_id, reviewer_id, level)
);
create index if not exists idx_occurrence_verif_occ on enterprise.occurrence_verification(occurrence_id);
create index if not exists idx_occurrence_verif_reviewer on enterprise.occurrence_verification(reviewer_id);

-- ── Lab result (top of the evidence ladder) ────────────────────────────────
create table if not exists enterprise.lab_result (
  id          uuid primary key default gen_random_uuid(),
  sample_id   uuid not null references enterprise.sample(id) on delete cascade,
  lab_name    text,
  assay       jsonb,
  grade_gpt   numeric(10,3),
  accredited  boolean not null default false,
  received_at timestamptz not null default now()
);
create index if not exists idx_lab_result_sample on enterprise.lab_result(sample_id);
create index if not exists idx_lab_result_accredited on enterprise.lab_result(accredited);
create index if not exists idx_lab_result_assay on enterprise.lab_result using gin (assay);

-- ── VERIFY (CI/CD) — expect: tables=4, uniques=2, gin=1, evtype_fk=1 ────────
--   select
--     (select count(*) from information_schema.tables where table_schema='enterprise'
--        and table_name in ('occurrence_evidence','sample_verification','occurrence_verification','lab_result')) as tables,
--     (select count(*) from pg_constraint c join pg_class t on c.conrelid=t.oid
--        where c.contype='u' and t.relname in ('sample_verification','occurrence_verification')) as uniques,
--     (select count(*) from pg_indexes where schemaname='enterprise' and indexdef like '%gin%'
--        and tablename='lab_result') as gin,
--     (select count(*) from pg_constraint c join pg_class t on c.conrelid=t.oid join pg_class r on c.confrelid=r.oid
--        where c.contype='f' and t.relname='occurrence_evidence' and r.relname='evidence_tier') as evtype_fk;

-- ── ROLLBACK (down-path) — clean drop; never touches `public`/auth ─────────
--   drop table if exists enterprise.lab_result;
--   drop table if exists enterprise.occurrence_verification;
--   drop table if exists enterprise.sample_verification;
--   drop table if exists enterprise.occurrence_evidence;

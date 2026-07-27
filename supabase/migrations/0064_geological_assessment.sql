-- 0064_geological_assessment.sql
--
-- Sprint 4.3 (GIE) S1 — the assessment parent row: one geological assessment per
-- run of analyze-sample over a sample. Holds the engine version, an idempotency
-- hash of the inputs, the engine-computed overall confidence (0–100, NEVER an AI
-- number), and the structured report (conclusions summary + uncertainties +
-- missing information + recommendations) as JSONB. The traceable evidence graph
-- is normalised into child tables (0065).
--
-- Additive; geo schema. RLS follows the parent sample (can_read_sample); writes
-- are service-role only (the analyze-sample function).

create table if not exists geo.geological_assessment (
  id                 uuid primary key default gen_random_uuid(),
  sample_id          uuid not null references enterprise.sample(id) on delete cascade,
  engine_version     text not null,
  model              text,                                   -- Gemini model used (audit)
  input_hash         text,                                   -- idempotency: sample + evidence inputs
  status             text not null default 'ai_processing',  -- ai_processing → ai_completed | failed
  overall_confidence numeric(5,2),                           -- engine-computed, 0..100
  report             jsonb not null default '{}'::jsonb,     -- report + uncertainties + missing_info + recommendations
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint ck_assessment_overall_conf
    check (overall_confidence is null or (overall_confidence >= 0 and overall_confidence <= 100)),
  constraint ck_assessment_status
    check (status in ('ai_processing','ai_completed','failed'))
);

create index if not exists idx_assessment_sample
  on geo.geological_assessment(sample_id, created_at desc);

-- Idempotency: one assessment per (sample, input_hash) so re-runs don't duplicate.
create unique index if not exists uq_assessment_sample_input
  on geo.geological_assessment(sample_id, input_hash) where input_hash is not null;

-- Helper: may the caller read this assessment? (follows the parent sample's RLS)
create or replace function geo.can_read_assessment(p_assessment uuid)
returns boolean
language sql
stable
security definer
set search_path = geo, enterprise, pg_temp
as $$
  select exists (
    select 1 from geo.geological_assessment a
    where a.id = p_assessment and enterprise.can_read_sample(a.sample_id)
  );
$$;
grant execute on function geo.can_read_assessment(uuid) to authenticated, service_role;

alter table geo.geological_assessment enable row level security;

drop policy if exists geological_assessment_select on geo.geological_assessment;
create policy geological_assessment_select on geo.geological_assessment for select to authenticated
  using (enterprise.can_read_sample(sample_id));

grant select on geo.geological_assessment to authenticated;
grant select, insert, update on geo.geological_assessment to service_role;

-- ── VERIFY — expect rls on, 1 policy, auth=select-only ──────────────────────
--   select relrowsecurity from pg_class where oid='geo.geological_assessment'::regclass;      -- t
--   select count(*) from pg_policies where schemaname='geo' and tablename='geological_assessment'; -- 1
--   select has_table_privilege('authenticated','geo.geological_assessment','insert');          -- f

-- ── ROLLBACK ──
--   drop table if exists geo.geological_assessment cascade;
--   drop function if exists geo.can_read_assessment(uuid);

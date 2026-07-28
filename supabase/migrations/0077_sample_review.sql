-- 0077_sample_review.sql
--
-- Review Console S2 — the permanent Geologist Review Object. One row per reviewer
-- per review round of a sample. Supports Save-Draft (status='draft', editable across
-- sessions) then a binding submission (Verify | Needs More Data | Reject), and
-- multiple rounds (§1, §8). reviewer_role is free TEXT so future disciplines (GIS
-- Analyst, Metallurgist, Environmental Specialist, External Consultant) need no
-- schema change (§7). The AI assessment is never touched — this records the human
-- review alongside it (§2, §9). Append-only history: drafts update in place, but
-- submitted rows and the audit_log are never deleted.

create table if not exists enterprise.sample_review (
  id                     uuid primary key default gen_random_uuid(),
  sample_id              uuid not null references enterprise.sample(id) on delete cascade,
  reviewer_id            uuid references auth.users(id) on delete set null,
  reviewer_role          text not null,                         -- discipline/role at review time (future-proof)
  round_no               integer not null default 1,            -- review cycle (§8)
  status                 text not null default 'draft',         -- draft | submitted (§1)
  decision               text,                                  -- verify | needs_more_data | reject (null while draft)
  geologist_confidence   numeric(5,2),                          -- 0..100, separate from ai_confidence (§2)
  corrected_interpretation text,
  review_notes           text,
  recommendation         text,
  evidence_references    jsonb not null default '[]'::jsonb,    -- evidence ids / dataset refs the reviewer cites
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  submitted_at           timestamptz,
  constraint ck_review_status   check (status in ('draft','submitted')),
  constraint ck_review_decision check (decision is null or decision in ('verify','needs_more_data','reject')),
  constraint ck_review_conf     check (geologist_confidence is null or (geologist_confidence >= 0 and geologist_confidence <= 100)),
  constraint uq_review_round     unique (sample_id, reviewer_id, round_no)
);
create index if not exists idx_sample_review_sample on enterprise.sample_review(sample_id, round_no desc);

-- Collector ≠ Reviewer, double-gated like verification: a collector may review their
-- own sample ONLY when the dev self_review flag is on AND they are the owner-beta
-- account (0076). Never permitted in production.
create or replace function enterprise.enforce_review_not_collector()
returns trigger
language plpgsql security definer
set search_path = enterprise, auth, pg_temp
as $$
declare v_collector uuid; v_self_ok boolean := false;
begin
  select collector_id into v_collector from enterprise.sample where id = new.sample_id;
  if new.reviewer_id is not null and new.reviewer_id = v_collector then
    select coalesce((select default_enabled from enterprise.feature_flag where key = 'self_review'), false)
           and exists (select 1 from auth.users u where u.id = new.reviewer_id and lower(u.email) = 'awmusse.musse@gmail.com')
      into v_self_ok;
    if not v_self_ok then
      raise exception 'Collector != Reviewer: a sample''s collector cannot review their own sample';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_review_not_collector on enterprise.sample_review;
create trigger trg_review_not_collector
  before insert or update on enterprise.sample_review
  for each row execute function enterprise.enforce_review_not_collector();

alter table enterprise.sample_review enable row level security;

-- Read: anyone who can read the parent sample. Writes are service-role only (RPC).
drop policy if exists sample_review_select on enterprise.sample_review;
create policy sample_review_select on enterprise.sample_review for select to authenticated
  using (enterprise.can_read_sample(sample_id));

grant select on enterprise.sample_review to authenticated;
grant select, insert, update on enterprise.sample_review to service_role;

-- ── VERIFY ── rls on; auth cannot insert; unique(sample,reviewer,round) ─────
--   select relrowsecurity from pg_class where oid='enterprise.sample_review'::regclass;   -- t
--   select has_table_privilege('authenticated','enterprise.sample_review','insert');      -- f

-- ── ROLLBACK ──
--   drop table if exists enterprise.sample_review;
--   drop function if exists enterprise.enforce_review_not_collector();

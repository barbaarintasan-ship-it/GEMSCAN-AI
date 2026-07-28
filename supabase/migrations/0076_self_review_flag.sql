-- 0076_self_review_flag.sql
--
-- Review Console S1 — a DEV-ONLY self-review escape hatch (§7). During beta the
-- owner is both collector and reviewer, but the Collector≠Verifier invariant (0038)
-- normally forbids that. This adds a feature flag and rewires the trigger to permit
-- self-review ONLY when BOTH gates hold: the flag is enabled AND the reviewer is the
-- owner-beta account. Defaults OFF; must never be enabled in production.

insert into enterprise.feature_flag (key, description, default_enabled, is_beta)
values ('self_review',
        'DEV ONLY — allow the owner-beta account to review its own samples. NEVER enable in production.',
        false, true)
on conflict (key) do nothing;

-- Double-gated Collector≠Verifier enforcement.
create or replace function enterprise.enforce_reviewer_not_collector()
returns trigger
language plpgsql security definer
set search_path = enterprise, auth, pg_temp
as $$
declare
  v_collector uuid;
  v_self_ok boolean := false;
begin
  select collector_id into v_collector from enterprise.sample where id = new.sample_id;
  if new.reviewer_id is not null and new.reviewer_id = v_collector then
    -- Gate 1: the self_review flag is enabled.  Gate 2: reviewer is the owner-beta account.
    select coalesce((select default_enabled from enterprise.feature_flag where key = 'self_review'), false)
           and exists (select 1 from auth.users u
                       where u.id = new.reviewer_id and lower(u.email) = 'awmusse.musse@gmail.com')
      into v_self_ok;
    if not v_self_ok then
      raise exception 'Collector != Verifier: a sample''s collector cannot verify their own sample';
    end if;
  end if;
  return new;
end;
$$;

-- ── VERIFY ── flag present + off; trigger still enforces for non-owner ──────
--   select default_enabled from enterprise.feature_flag where key='self_review';  -- f
--   (with flag off, any self-review insert must still raise)

-- ── ROLLBACK ── restore the 0038 trigger body + delete the flag.
--   delete from enterprise.feature_flag where key='self_review';

-- 0038_verification_policies.sql
--
-- Luul Scan Enterprise — Phase 1, Sprint 3 (6/N, SECURITY): read policies for
-- occurrence_evidence, sample_verification, occurrence_verification, lab_result,
-- with SERVICE-ROLE-ONLY writes, plus the hard "Collector != Verifier" invariant.
--
-- Security only (SELECT policies + read grants + 1 helper + 2 guard triggers) —
-- NO schema DDL. Frozen schema (0018-0032), public/consumer, production untouched.
--
-- Decisions:
--   * Verification writes are SERVICE-ROLE-ONLY (A2.4). The community-vs-expert
--     distinction and the reputation-weight are computed by the submit-verification
--     Edge Function (Sprint 5). Choosing A2.4 over the looser "authenticated may
--     insert community verification" wording so weights are server-computed.
--   * Collector != Verifier is enforced by a DB TRIGGER that fires for EVERY role
--     (including service_role — triggers are not bypassed by BYPASSRLS), making it
--     a database invariant, not just an Edge-Function rule.
--
-- Recursion safety: helpers/triggers are SECURITY DEFINER (bypass RLS). Idempotent.

-- ── Companion helper ───────────────────────────────────────────────────────
create or replace function enterprise.can_read_occurrence(p_occ uuid)
returns boolean
language sql stable security definer
set search_path = enterprise, pg_temp
as $$
  select exists (
    select 1 from enterprise.occurrence_evidence oe
    where oe.id = p_occ and enterprise.can_read_area(oe.exploration_area_id)
  );
$$;
grant execute on function enterprise.can_read_occurrence(uuid) to authenticated, service_role;

-- ── Collector != Verifier guard triggers (fire for ALL roles) ──────────────
create or replace function enterprise.enforce_reviewer_not_collector()
returns trigger
language plpgsql security definer
set search_path = enterprise, pg_temp
as $$
declare v_collector uuid;
begin
  select collector_id into v_collector from enterprise.sample where id = new.sample_id;
  if new.reviewer_id is not null and new.reviewer_id = v_collector then
    raise exception 'Collector != Verifier: a sample''s collector cannot verify their own sample';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_sample_verif_reviewer on enterprise.sample_verification;
create trigger trg_sample_verif_reviewer
  before insert or update on enterprise.sample_verification
  for each row execute function enterprise.enforce_reviewer_not_collector();

create or replace function enterprise.enforce_occ_reviewer_not_collector()
returns trigger
language plpgsql security definer
set search_path = enterprise, pg_temp
as $$
declare v_collector uuid;
begin
  select s.collector_id into v_collector
  from enterprise.occurrence_evidence oe
  left join enterprise.sample s on s.id = oe.sample_id
  where oe.id = new.occurrence_id;
  if new.reviewer_id is not null and v_collector is not null and new.reviewer_id = v_collector then
    raise exception 'Collector != Verifier: the linked sample''s collector cannot verify this occurrence';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_occ_verif_reviewer on enterprise.occurrence_verification;
create trigger trg_occ_verif_reviewer
  before insert or update on enterprise.occurrence_verification
  for each row execute function enterprise.enforce_occ_reviewer_not_collector();

-- ── Grants: authenticated = SELECT only; service_role = full (writes) ──────
grant select on enterprise.occurrence_evidence, enterprise.sample_verification,
                enterprise.occurrence_verification, enterprise.lab_result
  to authenticated;
grant select, insert, update, delete on enterprise.occurrence_evidence,
     enterprise.sample_verification, enterprise.occurrence_verification, enterprise.lab_result
  to service_role;

-- ── SELECT policies (writes intentionally have NO authenticated policy) ─────
drop policy if exists occurrence_select on enterprise.occurrence_evidence;
create policy occurrence_select on enterprise.occurrence_evidence for select to authenticated
  using (enterprise.can_read_area(exploration_area_id));

drop policy if exists sample_verif_select on enterprise.sample_verification;
create policy sample_verif_select on enterprise.sample_verification for select to authenticated
  using (enterprise.can_read_sample(sample_id));

drop policy if exists occurrence_verif_select on enterprise.occurrence_verification;
create policy occurrence_verif_select on enterprise.occurrence_verification for select to authenticated
  using (enterprise.can_read_occurrence(occurrence_id));

drop policy if exists lab_result_select on enterprise.lab_result;
create policy lab_result_select on enterprise.lab_result for select to authenticated
  using (enterprise.can_read_sample(sample_id));

-- ── VERIFY (CI/CD) — expect: select_pol=4, write_pol=0, helper=1, reviewer_triggers=2 ──
--   select
--     (select count(*) from pg_policies where schemaname='enterprise' and cmd='SELECT'
--        and tablename in ('occurrence_evidence','sample_verification','occurrence_verification','lab_result')) as select_pol,
--     (select count(*) from pg_policies where schemaname='enterprise' and cmd in ('INSERT','UPDATE','DELETE','ALL')
--        and tablename in ('occurrence_evidence','sample_verification','occurrence_verification','lab_result')) as write_pol,
--     (select count(*) from pg_proc p join pg_namespace n on p.pronamespace=n.oid
--        where n.nspname='enterprise' and p.proname='can_read_occurrence') as helper,
--     (select count(*) from pg_trigger where tgname in ('trg_sample_verif_reviewer','trg_occ_verif_reviewer') and not tgisinternal) as reviewer_triggers;

-- ── ROLLBACK (down-path) — drop policies, grants, triggers, functions, helper ─
--   drop policy if exists lab_result_select on enterprise.lab_result;
--   drop policy if exists occurrence_verif_select on enterprise.occurrence_verification;
--   drop policy if exists sample_verif_select on enterprise.sample_verification;
--   drop policy if exists occurrence_select on enterprise.occurrence_evidence;
--   revoke select, insert, update, delete on enterprise.occurrence_evidence, enterprise.sample_verification,
--     enterprise.occurrence_verification, enterprise.lab_result from authenticated, service_role;
--   drop trigger if exists trg_occ_verif_reviewer on enterprise.occurrence_verification;
--   drop trigger if exists trg_sample_verif_reviewer on enterprise.sample_verification;
--   drop function if exists enterprise.enforce_occ_reviewer_not_collector();
--   drop function if exists enterprise.enforce_reviewer_not_collector();
--   drop function if exists enterprise.can_read_occurrence(uuid);

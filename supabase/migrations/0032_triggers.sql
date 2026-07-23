-- 0032_triggers.sql
--
-- Luul Scan Enterprise — Phase 1, Sprint 2 (14/14): the enterprise updated_at
-- trigger function and its attachment to every enterprise table that carries an
-- `updated_at` column.
--
-- Additive & isolated (enterprise). Idempotent (CREATE OR REPLACE function;
-- DROP TRIGGER IF EXISTS before CREATE). Defines a DEDICATED
-- enterprise.set_updated_at() — it does NOT overload the consumer
-- public.set_updated_at(). Depends on: all Sprint-2 tables (0019–0031).

-- ── Trigger function ───────────────────────────────────────────────────────
create or replace function enterprise.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ── Attach to every enterprise table with an updated_at column ─────────────
do $$
declare t text;
begin
  foreach t in array array[
    'config_entry','exploration_area','exploration_mission','field_contributor',
    'mission_progress','occurrence_evidence','organization','project','sample','taxonomy'
  ]
  loop
    execute format('drop trigger if exists trg_set_updated_at on enterprise.%I;', t);
    execute format(
      'create trigger trg_set_updated_at before update on enterprise.%I '
      || 'for each row execute function enterprise.set_updated_at();', t);
  end loop;
end $$;

-- ── VERIFY (CI/CD) — expect: function=1, triggers=10 ───────────────────────
--   select
--     (select count(*) from pg_proc p join pg_namespace n on p.pronamespace=n.oid
--        where n.nspname='enterprise' and p.proname='set_updated_at') as fn,
--     (select count(*) from pg_trigger where tgname='trg_set_updated_at' and not tgisinternal) as triggers;

-- ── ROLLBACK (down-path) — drop triggers + function; never touches public ──
--   do $$ declare t text; begin
--     foreach t in array array['config_entry','exploration_area','exploration_mission',
--       'field_contributor','mission_progress','occurrence_evidence','organization',
--       'project','sample','taxonomy']
--     loop execute format('drop trigger if exists trg_set_updated_at on enterprise.%I;', t); end loop;
--   end $$;
--   drop function if exists enterprise.set_updated_at();

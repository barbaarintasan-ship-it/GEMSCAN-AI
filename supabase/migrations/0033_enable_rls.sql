-- 0033_enable_rls.sql
--
-- Luul Scan Enterprise — Phase 1, Sprint 3 (1/N, SECURITY): enable Row Level
-- Security with DEFAULT-DENY on every table in the enterprise/geo/ml schemas.
--
-- Enabling RLS with NO policies = deny all access for the `anon` and
-- `authenticated` roles (default-deny). The Supabase `service_role` (BYPASSRLS)
-- still works, so Edge-Function writes (Sprint 5) are unaffected. Subsequent
-- Sprint-3 migrations (0034+) add the specific policies that selectively open
-- access.
--
-- This is a SECURITY setting only — it creates/alters/drops NO tables, columns,
-- types, constraints, indexes, or FKs. It does not touch the frozen schema
-- (0018-0032), `public`/consumer, or production.
--
-- Idempotent: `enable row level security` is a no-op if already enabled; the DO
-- loop covers every current table so the set can't drift. Documented rollback
-- disables RLS again (returning to pre-0033 state).

do $$
declare r record;
begin
  for r in
    select schemaname, tablename
    from pg_tables
    where schemaname in ('enterprise','geo','ml')
    order by schemaname, tablename
  loop
    execute format('alter table %I.%I enable row level security;', r.schemaname, r.tablename);
  end loop;
end $$;

-- ── VERIFY (CI/CD) — expect: rls_enabled = total tables, policies = 0 ──────
--   select
--     (select count(*) from pg_tables
--        where schemaname in ('enterprise','geo','ml') and rowsecurity) as rls_enabled,
--     (select count(*) from pg_tables where schemaname in ('enterprise','geo','ml')) as total_tables,
--     (select count(*) from pg_policies where schemaname in ('enterprise','geo','ml')) as policies; -- expect 0 (default-deny)

-- ── ROLLBACK (down-path) — disable RLS again; touches no structure ─────────
--   do $$ declare r record; begin
--     for r in select schemaname, tablename from pg_tables
--       where schemaname in ('enterprise','geo','ml')
--     loop execute format('alter table %I.%I disable row level security;', r.schemaname, r.tablename); end loop;
--   end $$;

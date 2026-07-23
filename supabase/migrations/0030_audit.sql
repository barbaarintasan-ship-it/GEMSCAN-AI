-- 0030_audit.sql
--
-- Luul Scan Enterprise — Phase 1, Sprint 2 (12/14): the immutable, tamper-
-- evident audit ledger (A2.2.2 + A3.1.5). Append-only; written by Edge
-- Functions (service role) only. The hash-chain columns (prev_hash/row_hash)
-- make any post-hoc tampering detectable.
--
-- Additive & isolated (enterprise). Idempotent. Depends on: 0018 (enum
-- audit_action), 0020 (auth.users). Row-level immutability (no update/delete)
-- is enforced by RLS in Sprint 3; this migration only creates the table.

create table if not exists enterprise.audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references auth.users(id) on delete set null,
  action      enterprise.audit_action not null,
  entity_type text not null,
  entity_id   uuid not null,
  before      jsonb,
  after       jsonb,
  context     jsonb,                                      -- request id, function name, ...
  prev_hash   text,                                       -- previous row's row_hash (chain)
  row_hash    text,                                       -- hash(actor,action,entity,before,after,prev_hash,ts)
  device_id   text,
  ip_hash     text,                                       -- hashed IP (privacy)
  signature   text,                                       -- optional service signature
  created_at  timestamptz not null default now()
);
create index if not exists idx_audit_log_entity on enterprise.audit_log(entity_type, entity_id);
create index if not exists idx_audit_log_actor on enterprise.audit_log(actor_id);
create index if not exists idx_audit_log_created_brin on enterprise.audit_log using brin (created_at);

-- ── VERIFY (CI/CD) — expect: tables=1, brin=1, has_hash_cols=2 ─────────────
--   select
--     (select count(*) from information_schema.tables where table_schema='enterprise' and table_name='audit_log') as tables,
--     (select count(*) from pg_indexes where schemaname='enterprise' and indexname='idx_audit_log_created_brin') as brin,
--     (select count(*) from information_schema.columns where table_schema='enterprise' and table_name='audit_log'
--        and column_name in ('prev_hash','row_hash')) as hash_cols;

-- ── ROLLBACK (down-path) — clean drop; never touches `public`/auth ─────────
--   drop table if exists enterprise.audit_log;

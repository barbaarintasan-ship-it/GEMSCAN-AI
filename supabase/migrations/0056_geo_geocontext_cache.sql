-- 0056_geo_geocontext_cache.sql
--
-- Luul Scan — GeoContext P0 (13/N, final schema): geo.geocontext_cache.
--
-- Runtime write-through cache of assembled GeoContext JSON, keyed by H3 cell +
-- engine version (Architecture v1.1 §7/§12). The GeoContext Edge Function checks
-- this before running providers and writes the result back with a TTL.
--
-- SERVICE-ONLY (like the operational tables in 0043): this is an internal runtime
-- mechanism — clients receive GeoContext via the Edge Function, never by reading the
-- cache table. RLS is enabled with NO authenticated policy (default-deny for
-- authenticated is intentional, not an omission); service_role has full DML.
--
-- Schema-change-only, one table (Rule 1). geo schema, additive; frozen core/public
-- untouched. Idempotent. This is the LAST P0 schema migration.

create table if not exists geo.geocontext_cache (
  id             uuid primary key default gen_random_uuid(),
  h3             text not null,                            -- H3 cell id (encodes resolution)
  resolution     smallint,                                 -- H3 resolution (convenience filter)
  engine_version text not null,                            -- GeoContext engine version that produced this
  payload        jsonb not null,                           -- the cached GeoContext JSON
  computed_at    timestamptz not null default now(),
  expires_at     timestamptz,                              -- TTL; null = no expiry
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ── Indexes ────────────────────────────────────────────────────────────────
-- One cache entry per cell per engine version (write-through upsert target).
create unique index if not exists uq_geocontext_cache_cell
  on geo.geocontext_cache (h3, engine_version);
create index if not exists idx_geocontext_cache_expires on geo.geocontext_cache (expires_at);

-- ── updated_at trigger (reuse enterprise.set_updated_at from 0032) ──────────
drop trigger if exists trg_set_updated_at on geo.geocontext_cache;
create trigger trg_set_updated_at before update on geo.geocontext_cache
  for each row execute function enterprise.set_updated_at();

-- ── RLS: SERVICE-ONLY (authenticated default-deny, documented) ─────────────
alter table geo.geocontext_cache enable row level security;
alter table geo.geocontext_cache force row level security;

grant select, insert, update, delete on geo.geocontext_cache to service_role;
-- (no grant / no policy for authenticated → default-deny; service_role via BYPASSRLS)

-- ── VERIFY (CI/CD) — expect: table=1, rls=on, policies=0, auth_grants=0, service_grants=4, uq_cell=1 ──
--   select
--     (select count(*) from pg_tables where schemaname='geo' and tablename='geocontext_cache') as tbl,
--     (select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='geo' and c.relname='geocontext_cache') as rls,
--     (select count(*) from pg_policies where schemaname='geo' and tablename='geocontext_cache') as policies,          -- expect 0 (service-only)
--     (select count(*) from information_schema.role_table_grants where grantee='authenticated' and table_schema='geo' and table_name='geocontext_cache') as auth_grants, -- expect 0
--     (select count(*) from information_schema.role_table_grants where grantee='service_role' and table_schema='geo' and table_name='geocontext_cache' and privilege_type in ('SELECT','INSERT','UPDATE','DELETE')) as service_grants, -- expect 4
--     (select count(*) from pg_indexes where schemaname='geo' and tablename='geocontext_cache' and indexname='uq_geocontext_cache_cell') as uq_cell;

-- ── ROLLBACK (down-path) ───────────────────────────────────────────────────
--   revoke select, insert, update, delete on geo.geocontext_cache from service_role;
--   drop trigger if exists trg_set_updated_at on geo.geocontext_cache;
--   drop table if exists geo.geocontext_cache;

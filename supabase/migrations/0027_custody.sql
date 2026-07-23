-- 0027_custody.sql
--
-- Luul Scan Enterprise — Phase 1, Sprint 2 (9/14): laboratory chain of custody
-- (A3.1.4) — containers, shipments, the Field→…→Verified event trail, and
-- tamper-evident custody signatures.
--
-- Additive & isolated (enterprise). Idempotent. Depends on: 0018 (schemas,
-- postgis), 0020 (organization, auth.users), 0023 (sample).

-- ── Sample container (bag/label) ───────────────────────────────────────────
create table if not exists enterprise.sample_container (
  id             uuid primary key default gen_random_uuid(),
  sample_id      uuid references enterprise.sample(id) on delete cascade,
  container_code text unique,
  sealed_by      uuid references auth.users(id) on delete set null,
  sealed_at      timestamptz,
  notes          text
);
create index if not exists idx_sample_container_sample on enterprise.sample_container(sample_id);

-- ── Shipment ───────────────────────────────────────────────────────────────
create table if not exists enterprise.shipment (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid references enterprise.organization(id) on delete set null,
  carrier         text,
  tracking_ref    text,
  origin          text,
  destination_lab text,
  shipped_at      timestamptz,
  received_at     timestamptz,
  status          text,                                    -- created|in_transit|received|prepared|assayed
  created_at      timestamptz not null default now()
);
create index if not exists idx_shipment_org on enterprise.shipment(organization_id);

-- ── Chain event (Field→Bagged→…→Verified) ──────────────────────────────────
create table if not exists enterprise.sample_chain_event (
  id           uuid primary key default gen_random_uuid(),
  sample_id    uuid not null references enterprise.sample(id) on delete cascade,
  container_id uuid references enterprise.sample_container(id) on delete set null,
  shipment_id  uuid references enterprise.shipment(id) on delete set null,
  event_type   text not null,                              -- collected|bagged|transported|received|prepared|assayed|verified
  actor_id     uuid references auth.users(id) on delete set null,
  occurred_at  timestamptz,
  location     extensions.geography(Point,4326),
  notes        text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_chain_event_sample on enterprise.sample_chain_event(sample_id);
create index if not exists idx_chain_event_type on enterprise.sample_chain_event(event_type);
create index if not exists idx_chain_event_shipment on enterprise.sample_chain_event(shipment_id);
create index if not exists idx_chain_event_location on enterprise.sample_chain_event using gist (location);

-- ── Custody signature (tamper-evident) ─────────────────────────────────────
create table if not exists enterprise.custody_signature (
  id             uuid primary key default gen_random_uuid(),
  chain_event_id uuid not null references enterprise.sample_chain_event(id) on delete cascade,
  signer_id      uuid references auth.users(id) on delete set null,
  signed_at      timestamptz,
  signature_hash text
);
create index if not exists idx_custody_signature_event on enterprise.custody_signature(chain_event_id);

-- ── VERIFY (CI/CD) — expect: tables=4, gist=1, fks(->sample)=2 ─────────────
--   select
--     (select count(*) from information_schema.tables where table_schema='enterprise'
--        and table_name in ('sample_container','shipment','sample_chain_event','custody_signature')) as tables,
--     (select count(*) from pg_indexes where schemaname='enterprise' and indexdef like '%gist%'
--        and tablename='sample_chain_event') as gist,
--     (select count(*) from pg_constraint c join pg_class t on c.conrelid=t.oid join pg_class r on c.confrelid=r.oid
--        where c.contype='f' and r.relname='sample'
--        and t.relname in ('sample_container','sample_chain_event')) as fks_to_sample;

-- ── ROLLBACK (down-path) — clean drop; never touches `public`/auth ─────────
--   drop table if exists enterprise.custody_signature;
--   drop table if exists enterprise.sample_chain_event;
--   drop table if exists enterprise.shipment;
--   drop table if exists enterprise.sample_container;

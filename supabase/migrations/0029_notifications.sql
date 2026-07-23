-- 0029_notifications.sql
--
-- Luul Scan Enterprise — Phase 1, Sprint 2 (11/14): the event bus + notification
-- system (A3.1.7). Append-only domain events fan out to notifications and
-- outbound webhooks. Interfaces only — no fan-out worker logic here.
--
-- Additive & isolated (enterprise). Idempotent. Depends on: 0018, 0020
-- (organization, auth.users).

-- ── Event bus (append-only) ────────────────────────────────────────────────
create table if not exists enterprise.event (
  id              uuid primary key default gen_random_uuid(),
  type            text not null,                          -- sample.verified|area.confidence_changed|mission.completed|...
  organization_id uuid references enterprise.organization(id) on delete set null,
  actor_id        uuid references auth.users(id) on delete set null,
  subject_type    text,
  subject_id      uuid,
  payload         jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists idx_event_type on enterprise.event(type);
create index if not exists idx_event_subject on enterprise.event(subject_type, subject_id);
create index if not exists idx_event_created_brin on enterprise.event using brin (created_at);

-- ── Notification (per-user) ────────────────────────────────────────────────
create table if not exists enterprise.notification (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  event_id   uuid references enterprise.event(id) on delete cascade,
  channel    text,                                        -- in_app|email|push
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_notification_user on enterprise.notification(user_id, read_at);

-- ── Notification preferences ───────────────────────────────────────────────
create table if not exists enterprise.notification_subscription (
  user_id    uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  channel    text not null default 'in_app',
  enabled    boolean not null default true,
  primary key (user_id, event_type, channel)
);

-- ── Outbound webhooks (enterprise integrations) ────────────────────────────
create table if not exists enterprise.webhook_endpoint (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid references enterprise.organization(id) on delete cascade,
  url             text not null,
  secret_hash     text,
  event_types     text[],
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);
create index if not exists idx_webhook_org on enterprise.webhook_endpoint(organization_id);

-- ── VERIFY (CI/CD) — expect: tables=4, brin=1 ──────────────────────────────
--   select
--     (select count(*) from information_schema.tables where table_schema='enterprise'
--        and table_name in ('event','notification','notification_subscription','webhook_endpoint')) as tables,
--     (select count(*) from pg_indexes where schemaname='enterprise' and indexname='idx_event_created_brin') as brin;

-- ── ROLLBACK (down-path) — clean drop; never touches `public`/auth ─────────
--   drop table if exists enterprise.webhook_endpoint;
--   drop table if exists enterprise.notification_subscription;
--   drop table if exists enterprise.notification;
--   drop table if exists enterprise.event;

-- GemScan AI — Initial schema: profiles + subscription entitlement
-- Payment separation contract (see 05-Monetization-Legal-Payments.md):
--   - This schema is the SOLE source of truth for subscription entitlement.
--   - It is written to ONLY by the website/backend payment webhooks (service_role),
--     NEVER by the mobile app, and NEVER by Apple/Google IAP receipt validation.
--   - The mobile app only ever READS its own subscription row via the
--     verify-subscription Edge Function (which itself just reads this table).

-- ── profiles ────────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  display_name text,
  locale text not null default 'en' check (locale in ('en', 'so')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id);

-- Profile row is created by a trigger on auth.users insert (see below),
-- so there is no client-side insert policy — inserts happen only via the
-- security-definer trigger function.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── subscriptions ────────────────────────────────────────────────────────────
-- One row per user representing their CURRENT entitlement state.
-- This table is updated exclusively by backend payment webhooks (service_role).
-- The mobile app has no INSERT/UPDATE/DELETE access — read-only, own-row-only.
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  tier text not null default 'free'
    check (tier in ('free', 'premium', 'lifetime', 'professional')),
  status text not null default 'active'
    check (status in ('active', 'past_due', 'canceled', 'expired')),
  -- Where the subscription was purchased. Always a WEBSITE payment rail —
  -- never 'ios_iap' / 'android_iap', by product decision (see 05-Monetization doc).
  source text
    check (
      source is null or source in (
        'stripe', 'paypal', 'mobile_money_evc', 'mobile_money_zaad',
        'mobile_money_sahal', 'mobile_money_edahab', 'bank_transfer'
      )
    ),
  external_reference_id text, -- e.g. Stripe subscription id / invoice id
  current_period_start timestamptz,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

alter table public.subscriptions enable row level security;

-- Mobile app / authenticated users may only READ their own row.
create policy "subscriptions_select_own"
  on public.subscriptions for select
  using (auth.uid() = user_id);

-- No insert/update/delete policy is granted to `authenticated` or `anon` —
-- only the service_role (used exclusively by backend webhook Edge Functions)
-- can write to this table. This is what makes "the mobile app can never
-- grant itself entitlement" true at the database level, not just in app code.

-- No separate index on (user_id) here: the `unique (user_id)` constraint
-- above already creates a unique btree index on that column, so an
-- additional single-column index would be a pure-overhead duplicate.

-- Every user gets a default free-tier row on signup, mirroring the profile trigger.
create or replace function public.handle_new_user_subscription()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.subscriptions (user_id, tier, status)
  values (new.id, 'free', 'active');
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_subscription on auth.users;
create trigger on_auth_user_created_subscription
  after insert on auth.users
  for each row execute function public.handle_new_user_subscription();

-- ── payment_events (audit log) ───────────────────────────────────────────────
-- Raw record of every inbound webhook event, for reconciliation/debugging.
-- Never exposed to the mobile app.
create table if not exists public.payment_events (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  event_type text not null,
  external_reference_id text,
  user_id uuid references auth.users (id) on delete set null,
  payload jsonb not null,
  processed_at timestamptz not null default now()
);

alter table public.payment_events enable row level security;
-- No policies at all for anon/authenticated: only service_role (which bypasses
-- RLS by default in Supabase) can read/write this table.

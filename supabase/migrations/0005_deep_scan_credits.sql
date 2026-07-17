-- Deep Scan credit system.
--
-- Standard Scan = one cheap AI model (unlimited-ish, abuse-capped).
-- Deep Scan     = the expensive 3-AI ensemble, METERED with credits:
--   * an included per-period allowance from the subscription tier, plus
--   * PURCHASED credits that roll over (deep_scan_credits.purchased_balance).
--
-- All writes here happen ONLY from the server (service_role in orchestrate-scan
-- / the website payment webhook). Clients get read-only access to their own
-- balance + usage, so credits can never be modified from the mobile app.

-- ── scan_usage ────────────────────────────────────────────────────────────
-- One row per scan actually run, for cost accounting and per-user reporting.
create table if not exists public.scan_usage (
  id                bigint generated always as identity primary key,
  user_id           uuid not null references auth.users (id) on delete cascade,
  scan_id           uuid references public.scans (id) on delete set null,
  scan_type         text not null check (scan_type in ('standard', 'deep')),
  ai_models_used    text[] not null default '{}',
  credits_used      integer not null default 0, -- 0 = covered by allowance/standard, 1 = purchased credit
  subscription_plan text not null default 'free',
  period_start      timestamptz, -- the subscription period this scan counted against
  created_at        timestamptz not null default now()
);

alter table public.scan_usage enable row level security;

-- Users may read their OWN usage; nobody but service_role may write.
drop policy if exists "scan_usage_select_own" on public.scan_usage;
create policy "scan_usage_select_own"
  on public.scan_usage for select
  to authenticated
  using (auth.uid() = user_id);

create index if not exists idx_scan_usage_user_period
  on public.scan_usage (user_id, scan_type, period_start, created_at desc);

-- ── deep_scan_credits ─────────────────────────────────────────────────────
-- Purchased Deep Scan credits that persist across subscription periods.
create table if not exists public.deep_scan_credits (
  user_id           uuid primary key references auth.users (id) on delete cascade,
  purchased_balance integer not null default 0 check (purchased_balance >= 0),
  updated_at        timestamptz not null default now()
);

alter table public.deep_scan_credits enable row level security;

drop policy if exists "deep_scan_credits_select_own" on public.deep_scan_credits;
create policy "deep_scan_credits_select_own"
  on public.deep_scan_credits for select
  to authenticated
  using (auth.uid() = user_id);
-- No INSERT/UPDATE/DELETE policy: only service_role can change balances.

-- ── credit_packages ───────────────────────────────────────────────────────
-- Configurable Deep Scan credit packs shown in the app / sold on the website.
create table if not exists public.credit_packages (
  id       bigint generated always as identity primary key,
  sku      text unique not null,
  label    text not null,
  price_usd numeric(8,2) not null,
  credits  integer not null check (credits > 0),
  active   boolean not null default true,
  sort     integer not null default 0
);

alter table public.credit_packages enable row level security;

-- Anyone may read the ACTIVE packages (they are just a price list, no secrets).
drop policy if exists "credit_packages_public_read" on public.credit_packages;
create policy "credit_packages_public_read"
  on public.credit_packages for select
  to anon, authenticated
  using (active = true);

insert into public.credit_packages (sku, label, price_usd, credits, sort) values
  ('deep_5',   '5 Deep Scans',   0.99,   5, 1),
  ('deep_30',  '30 Deep Scans',  4.99,  30, 2),
  ('deep_100', '100 Deep Scans', 9.99, 100, 3)
on conflict (sku) do nothing;

-- ── add_deep_scan_credits() ───────────────────────────────────────────────
-- Server-only helper the website payment webhook calls after a credit-pack
-- purchase. SECURITY DEFINER so it can upsert the balance; revoked from anon /
-- authenticated so a client can never grant itself credits.
create or replace function public.add_deep_scan_credits(p_user_id uuid, p_credits integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  new_balance integer;
begin
  if p_credits is null or p_credits <= 0 then
    raise exception 'p_credits must be positive';
  end if;

  insert into public.deep_scan_credits (user_id, purchased_balance, updated_at)
  values (p_user_id, p_credits, now())
  on conflict (user_id)
  do update set purchased_balance = public.deep_scan_credits.purchased_balance + excluded.purchased_balance,
                updated_at = now()
  returning purchased_balance into new_balance;

  return new_balance;
end;
$$;

revoke all on function public.add_deep_scan_credits(uuid, integer) from public, anon, authenticated;

-- ── consume_purchased_deep_scan_credit() ──────────────────────────────────
-- Atomically decrement one PURCHASED credit (only if the balance is > 0).
-- Returns the new balance, or -1 when there were none to spend. Server-only.
-- Atomic (single UPDATE ... WHERE > 0) so two concurrent scans can't
-- double-spend the same credit.
create or replace function public.consume_purchased_deep_scan_credit(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  new_balance integer;
begin
  update public.deep_scan_credits
     set purchased_balance = purchased_balance - 1,
         updated_at = now()
   where user_id = p_user_id
     and purchased_balance > 0
  returning purchased_balance into new_balance;

  if not found then
    return -1;
  end if;
  return new_balance;
end;
$$;

revoke all on function public.consume_purchased_deep_scan_credit(uuid) from public, anon, authenticated;

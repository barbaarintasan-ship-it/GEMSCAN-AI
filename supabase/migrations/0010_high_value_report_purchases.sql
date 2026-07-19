-- High-Value Verification Report purchases ($5 premium report).
--
-- The 15-step Advanced Diamond Verification questionnaire (0009) stays free.
-- What used to happen immediately on submit — the single verify-high-value
-- AI call — is now deferred until this purchase is marked 'paid'. Payment
-- itself NEVER happens in the app (App Store Guideline 3.1.1 / project
-- policy — see lib/appLinks.ts): the client only creates a 'pending' row
-- here and sends the user to a website payment page carrying this row's id
-- as a reference. A future payment-gateway webhook (see
-- supabase/functions/high-value-report-webhook) is the ONLY thing that ever
-- marks a row 'paid' and triggers the deferred AI call — mirrors the
-- client-owned-parent/service-role-verdict split already used by
-- diamond_verifications / diamond_verification_verdicts (0009).
--
-- Deliberately separate from `subscriptions` and `deep_scan_credits`: this is
-- a one-time, per-verification purchase, not a recurring plan or a spendable
-- credit pool.
create table if not exists public.high_value_report_purchases (
  id uuid primary key default gen_random_uuid(),
  verification_id uuid not null unique references public.diamond_verifications (id) on delete cascade,
  scan_id uuid not null references public.scans (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,

  status text not null default 'pending'
    check (status in ('pending', 'paid')),

  amount_usd numeric(10, 2) not null default 5.00,
  payment_method text check (payment_method in ('mobile_money', 'card')),

  -- Set by the payment webhook once a real gateway is wired (fail-closed
  -- until then — see high-value-report-webhook's GATEWAY_ENABLED kill switch).
  external_reference_id text,

  created_at timestamptz not null default now(),
  paid_at timestamptz
);

alter table public.high_value_report_purchases enable row level security;

create policy "high_value_report_purchases_select_own"
  on public.high_value_report_purchases for select
  using (auth.uid() = user_id);

-- The client creates its own 'pending' row when it reaches the paywall
-- screen (so the future webhook has something to look up by reference id).
-- It can never insert as 'paid' or set external_reference_id itself.
create policy "high_value_report_purchases_insert_own"
  on public.high_value_report_purchases for insert
  with check (
    auth.uid() = user_id
    and status = 'pending'
    and external_reference_id is null
    and exists (
      select 1 from public.diamond_verifications
      where diamond_verifications.id = high_value_report_purchases.verification_id
        and diamond_verifications.user_id = auth.uid()
    )
  );

-- No update/delete policy for authenticated/anon — only the payment webhook
-- (service_role) ever transitions a row to 'paid'.

create index if not exists idx_high_value_report_purchases_user_id_created_at
  on public.high_value_report_purchases (user_id, created_at desc);

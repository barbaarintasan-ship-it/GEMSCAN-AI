-- Gold Verification Mode.
--
-- A second, OPTIONAL, evidence-driven verification stage offered after a scan
-- whose result looks like it might be gold (native gold, gold-bearing rock,
-- gold ore/concentrate, or suspicious jewelry) — the gold-side counterpart to
-- Advanced Diamond Verification (0009-0012). Deliberately a PARALLEL set of
-- tables rather than a reuse of the diamond ones: high_value_report_purchases
-- already has a hard FK to diamond_verifications, so holding a gold purchase
-- there would require an invasive migration of a live table. Mirrors that
-- schema's ownership model and RLS shape exactly (client-owned-parent /
-- service-role-verdict split, atomic reserve/release evaluation-slot RPCs)
-- rather than generalizing it, matching this codebase's existing convention
-- of isolating verification features from each other.
--
-- No new storage bucket: verification photos reuse the EXISTING `scan-images`
-- bucket under a `.../verification/...` path, same as diamond verification.

-- ── gold_verifications ───────────────────────────────────────────────────────
create table if not exists public.gold_verifications (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.scans (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,

  status text not null default 'in_progress'
    check (status in ('in_progress', 'submitted', 'completed')),

  -- The questionnaire (origin, found-location, magnet, density inputs,
  -- scratch/streak/malleability, acid/XRF test results, claimed karat) as one
  -- flexible jsonb blob, same rationale as diamond_verifications.answers.
  answers jsonb not null default '{}'::jsonb,

  -- Storage paths of extra photos captured during the wizard (macro, side,
  -- top, bottom, edge, flash, wet, xrfReport — all optional), e.g.
  -- { "macro": "userId/scanId/verification/macro.jpg", ... }.
  image_paths jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (scan_id)
);

alter table public.gold_verifications enable row level security;

create policy "gold_verifications_select_own"
  on public.gold_verifications for select
  using (auth.uid() = user_id);

create policy "gold_verifications_insert_own"
  on public.gold_verifications for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.scans
      where scans.id = gold_verifications.scan_id and scans.user_id = auth.uid()
    )
  );

create policy "gold_verifications_update_own"
  on public.gold_verifications for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- No delete policy for authenticated/anon.

drop trigger if exists gold_verifications_set_updated_at on public.gold_verifications;
create trigger gold_verifications_set_updated_at
  before update on public.gold_verifications
  for each row execute function public.set_updated_at();

create index if not exists idx_gold_verifications_user_id_created_at
  on public.gold_verifications (user_id, created_at desc);

-- ── gold_verification_verdicts ───────────────────────────────────────────────
-- The final AI verdict (Stage: verify-gold-value), written exclusively by
-- that Edge Function using service_role — the client can never fabricate or
-- edit a verdict, mirroring diamond_verification_verdicts.
create table if not exists public.gold_verification_verdicts (
  id uuid primary key default gen_random_uuid(),
  verification_id uuid not null references public.gold_verifications (id) on delete cascade,
  scan_id uuid not null references public.scans (id) on delete cascade,

  -- Shape: { finalIdentification, confidence, probability, supportingEvidence,
  --          conflictingEvidence, mostLikelyAlternatives, recommendation,
  --          estimatedPurityOptions, estimatedMarketValue,
  --          professionalTestingRecommended, evidenceScore,
  --          recommendedNextTests, ... } — see verify-gold-value/prompt.ts
  -- for the authoritative shape.
  verdict jsonb not null,

  created_at timestamptz not null default now()
);

alter table public.gold_verification_verdicts enable row level security;

create policy "gold_verification_verdicts_select_own"
  on public.gold_verification_verdicts for select
  using (
    exists (
      select 1 from public.scans
      where scans.id = gold_verification_verdicts.scan_id and scans.user_id = auth.uid()
    )
  );

-- No insert/update/delete policy for authenticated/anon — service_role only.

create index if not exists idx_gold_verification_verdicts_verification_id
  on public.gold_verification_verdicts (verification_id);

-- ── gold_report_purchases ────────────────────────────────────────────────────
-- The $5 Gold Verification Report purchase, mirroring
-- high_value_report_purchases exactly but FK'd to gold_verifications so it
-- never touches the live diamond tables. Payment never happens in the app
-- (App Store Guideline 3.1.1 / project policy — see lib/appLinks.ts): the
-- client only creates a 'pending' row and sends the user to a website
-- payment page carrying this row's id as a reference. Only the gold report
-- payment webhook (service_role) ever marks a row 'paid'.
create table if not exists public.gold_report_purchases (
  id uuid primary key default gen_random_uuid(),
  verification_id uuid not null unique references public.gold_verifications (id) on delete cascade,
  scan_id uuid not null references public.scans (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,

  status text not null default 'pending'
    check (status in ('pending', 'paid')),

  amount_usd numeric(10, 2) not null default 5.00,
  payment_method text check (payment_method in ('mobile_money', 'card')),

  -- Set by the payment webhook once a real gateway is wired (fail-closed
  -- until then — see gold-report-webhook's GATEWAY_ENABLED kill switch).
  external_reference_id text,

  -- Guards the free-re-evaluation cap (3 per purchase) — see
  -- reserve_gvr_evaluation_slot/release_gvr_evaluation_slot below.
  evaluation_count integer not null default 0,

  created_at timestamptz not null default now(),
  paid_at timestamptz
);

alter table public.gold_report_purchases enable row level security;

create policy "gold_report_purchases_select_own"
  on public.gold_report_purchases for select
  using (auth.uid() = user_id);

create policy "gold_report_purchases_insert_own"
  on public.gold_report_purchases for insert
  with check (
    auth.uid() = user_id
    and status = 'pending'
    and external_reference_id is null
    and exists (
      select 1 from public.gold_verifications
      where gold_verifications.id = gold_report_purchases.verification_id
        and gold_verifications.user_id = auth.uid()
    )
  );

-- No update/delete policy for authenticated/anon — only the payment webhook
-- (service_role) ever transitions a row to 'paid'.

create index if not exists idx_gold_report_purchases_user_id_created_at
  on public.gold_report_purchases (user_id, created_at desc);

-- ── atomic evaluation-slot reserve/release ───────────────────────────────────
-- Same race-free pattern as reserve_hvr_evaluation_slot/release_hvr_evaluation_slot
-- (0012) — one atomic guarded UPDATE that checks the cap and increments in the
-- same statement, called at the very start of processVerification before any
-- AI work happens, with a companion release that gives the slot back if the
-- evaluation fails downstream so a transient failure never permanently costs
-- the user a slot.
create or replace function public.reserve_gvr_evaluation_slot(p_verification_id uuid, p_max integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count integer;
begin
  update public.gold_report_purchases
    set evaluation_count = evaluation_count + 1
    where verification_id = p_verification_id
      and status = 'paid'
      and evaluation_count < p_max
    returning evaluation_count into new_count;
  return new_count; -- null if no row matched: not paid, not found, or already at the cap
end;
$$;

create or replace function public.release_gvr_evaluation_slot(p_verification_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count integer;
begin
  update public.gold_report_purchases
    set evaluation_count = greatest(evaluation_count - 1, 0)
    where verification_id = p_verification_id
    returning evaluation_count into new_count;
  return new_count;
end;
$$;

revoke all on function public.reserve_gvr_evaluation_slot(uuid, integer) from public;
grant execute on function public.reserve_gvr_evaluation_slot(uuid, integer) to service_role;
revoke all on function public.release_gvr_evaluation_slot(uuid) from public;
grant execute on function public.release_gvr_evaluation_slot(uuid) to service_role;

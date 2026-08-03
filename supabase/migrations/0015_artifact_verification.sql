-- Artifact Verification Mode.
--
-- A second, OPTIONAL, evidence-driven verification stage offered after a scan
-- whose result looks like it might be a historical/archaeological artifact
-- (pottery, coins, tools, figurines, ornaments, architectural fragments,
-- inscribed objects, etc.) — the artifact-side counterpart to Advanced
-- Diamond Verification (0009-0012) and Gold Verification (0013). Deliberately
-- a PARALLEL set of tables rather than a reuse of the others, for the same
-- reason gold got its own: each verification feature stays isolated so it can
-- evolve, fail, or be rolled back independently.
--
-- No new storage bucket: verification photos reuse the EXISTING `scan-images`
-- bucket under a `.../verification/...` path, same as the other two.

-- ── artifact_verifications ───────────────────────────────────────────────────
create table if not exists public.artifact_verifications (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.scans (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,

  status text not null default 'in_progress'
    check (status in ('in_progress', 'submitted', 'completed')),

  -- The questionnaire (find location, buried/surface, found-with-others,
  -- cleaned, material, condition, inscriptions, size/weight, age claim) as one
  -- flexible jsonb blob, same rationale as the other verification tables.
  answers jsonb not null default '{}'::jsonb,

  -- Storage paths of extra photos captured during the wizard (macro, front,
  -- back, base, inside, broken, inscription, scale — all optional).
  image_paths jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (scan_id)
);

alter table public.artifact_verifications enable row level security;

create policy "artifact_verifications_select_own"
  on public.artifact_verifications for select
  using (auth.uid() = user_id);

create policy "artifact_verifications_insert_own"
  on public.artifact_verifications for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.scans
      where scans.id = artifact_verifications.scan_id and scans.user_id = auth.uid()
    )
  );

-- Re-validates scan_id ownership on UPDATE as well as INSERT, matching the
-- hardened diamond/gold update policies from 0014_security_fixes.sql (a
-- client must never be able to repoint their verification row at another
-- user's scan).
create policy "artifact_verifications_update_own"
  on public.artifact_verifications for update
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.scans
      where scans.id = artifact_verifications.scan_id and scans.user_id = auth.uid()
    )
  );

-- No delete policy for authenticated/anon.

drop trigger if exists artifact_verifications_set_updated_at on public.artifact_verifications;
create trigger artifact_verifications_set_updated_at
  before update on public.artifact_verifications
  for each row execute function public.set_updated_at();

create index if not exists idx_artifact_verifications_user_id_created_at
  on public.artifact_verifications (user_id, created_at desc);

-- ── artifact_verification_verdicts ───────────────────────────────────────────
-- The final AI verdict (Stage: verify-artifact-value), written exclusively by
-- that Edge Function using service_role — the client can never fabricate or
-- edit a verdict, mirroring the other verdict tables.
create table if not exists public.artifact_verification_verdicts (
  id uuid primary key default gen_random_uuid(),
  verification_id uuid not null references public.artifact_verifications (id) on delete cascade,
  scan_id uuid not null references public.scans (id) on delete cascade,

  -- Shape: { finalIdentification, confidence, probability, supportingEvidence,
  --          conflictingEvidence, mostLikelyAlternatives, recommendation,
  --          estimatedEra, estimatedCulture, inscriptionReading,
  --          estimatedMarketValue, professionalExaminationRecommended,
  --          heritageLegalNote, evidenceScore, recommendedNextSteps, ... } —
  -- see verify-artifact-value/prompt.ts for the authoritative shape.
  verdict jsonb not null,

  created_at timestamptz not null default now()
);

alter table public.artifact_verification_verdicts enable row level security;

create policy "artifact_verification_verdicts_select_own"
  on public.artifact_verification_verdicts for select
  using (
    exists (
      select 1 from public.scans
      where scans.id = artifact_verification_verdicts.scan_id and scans.user_id = auth.uid()
    )
  );

-- No insert/update/delete policy for authenticated/anon — service_role only.

create index if not exists idx_artifact_verification_verdicts_verification_id
  on public.artifact_verification_verdicts (verification_id);

-- ── artifact_report_purchases ────────────────────────────────────────────────
-- The $10 Artifact Verification Report purchase, mirroring gold_report_purchases
-- structurally but priced higher ($10, vs $5 for the diamond/gold reports).
-- The fixed-price CHECK constraint (same defense-in-depth idea as 0014's for
-- the other two tables) is set to 10.00 to match — a future policy edit can't
-- loosen it. FK'd to artifact_verifications so it never touches the other
-- verification tables.
create table if not exists public.artifact_report_purchases (
  id uuid primary key default gen_random_uuid(),
  verification_id uuid not null unique references public.artifact_verifications (id) on delete cascade,
  scan_id uuid not null references public.scans (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,

  status text not null default 'pending'
    check (status in ('pending', 'paid')),

  amount_usd numeric(10, 2) not null default 10.00,
  constraint artifact_report_purchases_amount_fixed check (amount_usd = 10.00),
  payment_method text check (payment_method in ('mobile_money', 'card')),

  -- Set by the payment webhook once a real gateway is wired (fail-closed
  -- until then — see artifact-report-webhook's GATEWAY_ENABLED kill switch).
  external_reference_id text,

  -- Guards the free-re-evaluation cap (3 per purchase) — see
  -- reserve_avr_evaluation_slot/release_avr_evaluation_slot below.
  evaluation_count integer not null default 0,

  created_at timestamptz not null default now(),
  paid_at timestamptz
);

alter table public.artifact_report_purchases enable row level security;

create policy "artifact_report_purchases_select_own"
  on public.artifact_report_purchases for select
  using (auth.uid() = user_id);

create policy "artifact_report_purchases_insert_own"
  on public.artifact_report_purchases for insert
  with check (
    auth.uid() = user_id
    and status = 'pending'
    and external_reference_id is null
    and exists (
      select 1 from public.artifact_verifications
      where artifact_verifications.id = artifact_report_purchases.verification_id
        and artifact_verifications.user_id = auth.uid()
    )
  );

-- No update/delete policy for authenticated/anon — only the payment webhook
-- (service_role) ever transitions a row to 'paid'.

create index if not exists idx_artifact_report_purchases_user_id_created_at
  on public.artifact_report_purchases (user_id, created_at desc);

-- ── atomic evaluation-slot reserve/release ───────────────────────────────────
-- Same race-free pattern as reserve_hvr/gvr_evaluation_slot (0012/0013).
create or replace function public.reserve_avr_evaluation_slot(p_verification_id uuid, p_max integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count integer;
begin
  update public.artifact_report_purchases
    set evaluation_count = evaluation_count + 1
    where verification_id = p_verification_id
      and status = 'paid'
      and evaluation_count < p_max
    returning evaluation_count into new_count;
  return new_count; -- null if no row matched: not paid, not found, or already at the cap
end;
$$;

create or replace function public.release_avr_evaluation_slot(p_verification_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count integer;
begin
  update public.artifact_report_purchases
    set evaluation_count = greatest(evaluation_count - 1, 0)
    where verification_id = p_verification_id
    returning evaluation_count into new_count;
  return new_count;
end;
$$;

revoke all on function public.reserve_avr_evaluation_slot(uuid, integer) from public;
grant execute on function public.reserve_avr_evaluation_slot(uuid, integer) to service_role;
revoke all on function public.release_avr_evaluation_slot(uuid) from public;
grant execute on function public.release_avr_evaluation_slot(uuid) to service_role;

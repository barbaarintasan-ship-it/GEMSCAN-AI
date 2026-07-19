-- Advanced Diamond Verification (High-Value Expert Workflow).
--
-- A second, OPTIONAL, evidence-driven verification stage offered after a
-- scan whose result looks like it might be a diamond-family/high-value
-- gemstone. It never reruns or replaces the original scan (supabase/functions/
-- orchestrate-scan) — it collects a structured questionnaire (hardness,
-- transparency, fire, sparkle, etc.) plus a few extra photos, then makes ONE
-- additional AI call (supabase/functions/verify-high-value) that weighs the
-- original scan's findings together with this new evidence.
--
-- Ownership model, mirroring the scans/scan_ai_responses split (0002):
--   - `diamond_verifications` is the client-owned parent: the user creates it
--     and updates it as they progress through the wizard (answers,
--     image_paths) — this is the first table in this schema with an
--     UPDATE-own policy, needed for step-by-step "save progress."
--   - `diamond_verification_verdicts` is service_role-only, exactly like
--     `scan_candidates` — the client can never write or fabricate a verdict.
-- No new storage bucket: verification photos are uploaded to the EXISTING
-- `scan-images` bucket under a `.../verification/...` path, already covered
-- by that bucket's existing per-user storage RLS policies (0002).

-- ── diamond_verifications ────────────────────────────────────────────────────
create table if not exists public.diamond_verifications (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.scans (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,

  status text not null default 'in_progress'
    check (status in ('in_progress', 'submitted', 'completed')),

  -- The questionnaire (hardness, transparency, fire, sparkle, shape, color,
  -- weight, magnet, fog, UV, loupe) as one flexible jsonb blob — steps are
  -- expected to evolve, so this deliberately isn't a wide fixed-column table.
  answers jsonb not null default '{}'::jsonb,

  -- Storage paths of any extra photos captured during the wizard (macro,
  -- side, top, bottom, edge, flash, wet — all optional), e.g.
  -- { "macro": "userId/scanId/verification/macro.jpg", ... }.
  image_paths jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (scan_id)
);

alter table public.diamond_verifications enable row level security;

create policy "diamond_verifications_select_own"
  on public.diamond_verifications for select
  using (auth.uid() = user_id);

create policy "diamond_verifications_insert_own"
  on public.diamond_verifications for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.scans
      where scans.id = diamond_verifications.scan_id and scans.user_id = auth.uid()
    )
  );

-- New precedent in this schema: the client needs to save wizard progress
-- (answers/image_paths) across many steps before final submission, unlike
-- every other client-owned table here which is insert-once/immutable. Scoped
-- to the owner's own row only — status/answers/image_paths are the only
-- columns this table exposes to the client at all (the verdict itself lives
-- in the separate service_role-only table below).
create policy "diamond_verifications_update_own"
  on public.diamond_verifications for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- No delete policy for authenticated/anon.

drop trigger if exists diamond_verifications_set_updated_at on public.diamond_verifications;
create trigger diamond_verifications_set_updated_at
  before update on public.diamond_verifications
  for each row execute function public.set_updated_at();

-- No separate index on (scan_id) here: the `unique (scan_id)` constraint
-- above already creates a unique btree index Postgres can use for scan_id
-- lookups too.
create index if not exists idx_diamond_verifications_user_id_created_at
  on public.diamond_verifications (user_id, created_at desc);

-- ── diamond_verification_verdicts ────────────────────────────────────────────
-- The final expert AI verdict (Stage: verify-high-value), written exclusively
-- by that Edge Function using service_role — the client can never fabricate
-- or edit a verdict, mirroring `scan_candidates`.
create table if not exists public.diamond_verification_verdicts (
  id uuid primary key default gen_random_uuid(),
  verification_id uuid not null references public.diamond_verifications (id) on delete cascade,
  scan_id uuid not null references public.scans (id) on delete cascade,

  -- Shape: { finalIdentification, confidence, probability, supportingEvidence,
  --          conflictingEvidence, mostLikelyAlternatives, recommendation,
  --          estimatedMarketValue, professionalTestingRecommended, ... } —
  -- see verify-high-value/prompt.ts for the authoritative shape.
  verdict jsonb not null,

  created_at timestamptz not null default now()
);

alter table public.diamond_verification_verdicts enable row level security;

create policy "diamond_verification_verdicts_select_own"
  on public.diamond_verification_verdicts for select
  using (
    exists (
      select 1 from public.scans
      where scans.id = diamond_verification_verdicts.scan_id and scans.user_id = auth.uid()
    )
  );

-- No insert/update/delete policy for authenticated/anon — service_role only.

create index if not exists idx_diamond_verification_verdicts_verification_id
  on public.diamond_verification_verdicts (verification_id);

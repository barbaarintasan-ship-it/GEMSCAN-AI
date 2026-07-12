-- GemScan AI — AI Scan Pipeline schema (Stages 1-7, see 03-AI-Architecture-and-Data-Sources.md
-- and 04-Technical-Architecture-Database-Security.md).
--
-- Ownership model:
--   - `scans` and `scan_images` are created by the MOBILE APP on behalf of the
--     signed-in user (client uploads its own capture + on-device enhanced
--     images and owns the row from creation).
--   - `scan_ai_responses` and `scan_candidates` (the cloud AI ensemble output)
--     are written ONLY by the orchestrate-scan Edge Function using
--     service_role — the client can never fabricate or edit an AI verdict,
--     mirroring the payment-separation "read-only entitlement" pattern already
--     used for `subscriptions`.
--   - `scans.status` / `scans.final_result` / `scans.confidence_band` are
--     likewise service_role-only columns in practice (no client update policy
--     exists on this table at all).

-- ── scans ────────────────────────────────────────────────────────────────────
create table if not exists public.scans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  specimen_category text
    check (
      specimen_category is null or specimen_category in (
        'gemstone', 'mineral', 'rock', 'crystal', 'meteorite',
        'precious_metal', 'jewelry', 'coin', 'hallmark', 'other'
      )
    ),

  status text not null default 'pending'
    check (status in ('pending', 'capturing', 'processing', 'completed', 'failed')),

  -- Optional, user-supplied, coarse location used only by the Geological
  -- Context Engine for locality re-ranking. Deliberately just lat/lng + an
  -- optional label — never a precise address — per the location-fuzzing
  -- policy in 05-Monetization-Legal-Payments.md (protects sensitive collecting
  -- sites from being inferred from user submissions).
  capture_location jsonb,

  -- Final ensemble decision (Stage 6). Null until orchestrate-scan completes.
  -- Shape: { bestMatch, confidenceScore, confidenceBand, reasoning,
  --          alternatives: [...], insufficientConfidence: boolean }
  final_result jsonb,
  confidence_band text
    check (confidence_band is null or confidence_band in ('low', 'medium', 'high')),

  processing_started_at timestamptz,
  processing_completed_at timestamptz,
  total_duration_ms integer,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.scans enable row level security;

create policy "scans_select_own"
  on public.scans for select
  using (auth.uid() = user_id);

create policy "scans_insert_own"
  on public.scans for insert
  with check (auth.uid() = user_id);

-- No update/delete policy for authenticated/anon: once created, a scan's
-- lifecycle (status, final_result, confidence_band, timings) is advanced only
-- by the orchestrate-scan Edge Function via service_role. This keeps "the
-- app cannot fabricate its own AI result" true at the database level.

create index if not exists idx_scans_user_id_created_at
  on public.scans (user_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists scans_set_updated_at on public.scans;
create trigger scans_set_updated_at
  before update on public.scans
  for each row execute function public.set_updated_at();

-- ── scan_images ──────────────────────────────────────────────────────────────
-- One row per captured angle (Stage 1) with on-device enhancement (Stage 3)
-- already applied by the time it's uploaded. Both the original and the
-- processed image are kept per the Stage 7 persistence requirement.
create table if not exists public.scan_images (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.scans (id) on delete cascade,

  angle text not null
    check (angle in ('front', 'back', 'left', 'right', 'top', 'bottom', 'macro', 'wet')),

  original_storage_path text not null,
  processed_storage_path text,

  -- Stage 1 automatic quality validation results, recorded for audit/tuning
  -- even though a bad image should already have been rejected client-side
  -- before upload.
  quality_score numeric,
  quality_flags jsonb, -- e.g. { "blurry": false, "lowLight": false }

  -- Stage 2 on-device detection output (crop box in the ORIGINAL image's
  -- coordinate space), recorded for reproducibility/debugging.
  detection_bbox jsonb, -- { "x", "y", "width", "height", "detectorConfidence" }

  width integer,
  height integer,

  created_at timestamptz not null default now(),

  unique (scan_id, angle)
);

alter table public.scan_images enable row level security;

create policy "scan_images_select_own"
  on public.scan_images for select
  using (
    exists (
      select 1 from public.scans
      where scans.id = scan_images.scan_id and scans.user_id = auth.uid()
    )
  );

create policy "scan_images_insert_own"
  on public.scan_images for insert
  with check (
    exists (
      select 1 from public.scans
      where scans.id = scan_images.scan_id and scans.user_id = auth.uid()
    )
  );

-- No separate single-column index on (scan_id) here: the `unique (scan_id,
-- angle)` constraint above already creates a composite index whose leading
-- column is scan_id, which Postgres can use for scan_id-only lookups too —
-- a dedicated (scan_id) index would be a duplicate.

-- ── scan_ai_responses ────────────────────────────────────────────────────────
-- Raw per-provider output (Stage 4), one row per provider call, kept verbatim
-- so the ensemble decision is always explainable and re-auditable. Written
-- exclusively by orchestrate-scan (service_role) — never by the client.
create table if not exists public.scan_ai_responses (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.scans (id) on delete cascade,

  provider text not null
    check (
      provider in (
        'on_device_classifier', 'gemini_vision', 'openai_vision', 'claude_vision',
        'hallmark_ocr', 'geological_context'
      )
    ),

  candidate_label text,
  confidence numeric, -- provider's own 0-1 confidence, before ensemble weighting
  reasoning text,
  alternatives jsonb, -- [{ label, confidence }, ...] as returned by this provider
  raw_response jsonb, -- full raw provider payload, for debugging/audit

  latency_ms integer,
  error text, -- populated instead of the above if this provider call failed

  created_at timestamptz not null default now()
);

alter table public.scan_ai_responses enable row level security;

create policy "scan_ai_responses_select_own"
  on public.scan_ai_responses for select
  using (
    exists (
      select 1 from public.scans
      where scans.id = scan_ai_responses.scan_id and scans.user_id = auth.uid()
    )
  );

-- No insert/update/delete policy for authenticated/anon — service_role only.

create index if not exists idx_scan_ai_responses_scan_id on public.scan_ai_responses (scan_id);

-- ── scan_candidates ──────────────────────────────────────────────────────────
-- The final, ranked ensemble output (Stage 5-6): best match plus the top five
-- alternatives, with why-chosen / why-rejected explanations. Written
-- exclusively by orchestrate-scan (service_role).
create table if not exists public.scan_candidates (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.scans (id) on delete cascade,

  rank integer not null, -- 1 = best match, 2-6 = alternatives
  label text not null,
  weighted_confidence numeric not null, -- final ensemble score, 0-1
  confidence_band text not null check (confidence_band in ('low', 'medium', 'high')),

  rationale text, -- why this candidate ranked where it did
  rejected_reason text, -- populated for rank > 1: why it lost to the best match

  created_at timestamptz not null default now()
);

alter table public.scan_candidates enable row level security;

create policy "scan_candidates_select_own"
  on public.scan_candidates for select
  using (
    exists (
      select 1 from public.scans
      where scans.id = scan_candidates.scan_id and scans.user_id = auth.uid()
    )
  );

-- No insert/update/delete policy for authenticated/anon — service_role only.

create index if not exists idx_scan_candidates_scan_id_rank
  on public.scan_candidates (scan_id, rank);

-- ── scan_feedback ────────────────────────────────────────────────────────────
-- Stage 7 requires persisting user feedback on the final result. This closes
-- the loop for the continuous-improvement knowledge base (see §03/§08).
create table if not exists public.scan_feedback (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.scans (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,

  was_correct boolean not null,
  corrected_label text,
  notes text,

  created_at timestamptz not null default now(),

  unique (scan_id)
);

alter table public.scan_feedback enable row level security;

create policy "scan_feedback_select_own"
  on public.scan_feedback for select
  using (auth.uid() = user_id);

create policy "scan_feedback_insert_own"
  on public.scan_feedback for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.scans
      where scans.id = scan_feedback.scan_id and scans.user_id = auth.uid()
    )
  );

-- No separate index on (scan_id) here: the `unique (scan_id)` constraint
-- above already creates a unique btree index on that column.

-- ── reference_hallmarks ──────────────────────────────────────────────────────
-- Reference database for the hallmark OCR sub-pipeline (Stage 4). Populated
-- by backend sync jobs from licensed sources (see §03 Tier 1/2/3 sourcing);
-- read-only for the app, never client-writable.
create table if not exists public.reference_hallmarks (
  id uuid primary key default gen_random_uuid(),
  mark_code text not null, -- the punched/stamped symbol or text, normalized
  country text,
  assay_office text,
  metal_type text, -- e.g. 'gold', 'silver', 'platinum'
  fineness text, -- e.g. '925', '18K', '750'
  period_start integer, -- year, approximate
  period_end integer,
  description text,
  image_storage_path text,
  source text, -- provenance of this reference record, for audit
  created_at timestamptz not null default now()
);

alter table public.reference_hallmarks enable row level security;

create policy "reference_hallmarks_select_all"
  on public.reference_hallmarks for select
  using (true);

-- No insert/update/delete policy for authenticated/anon — populated only by
-- backend sync jobs running as service_role.

create index if not exists idx_reference_hallmarks_mark_code
  on public.reference_hallmarks (mark_code);

-- The hallmark OCR provider (orchestrate-scan/providers/hallmarkOcr.ts) looks
-- up transcribed marks with `ilike('mark_code', '%<mark>%')` — a
-- leading-wildcard pattern that a plain btree index (above) cannot serve, so
-- Postgres would fall back to a full table scan as this table grows. Add a
-- trigram GIN index, which Postgres can use for both LIKE/ILIKE with
-- wildcards on either side.
create extension if not exists pg_trgm;

create index if not exists idx_reference_hallmarks_mark_code_trgm
  on public.reference_hallmarks using gin (mark_code gin_trgm_ops);

-- ── storage: scan-images bucket ──────────────────────────────────────────────
-- Original + on-device-processed captures are uploaded directly from the
-- mobile app to Storage, under a path namespaced by the owning user, then
-- referenced by scan_images.original_storage_path / processed_storage_path.
insert into storage.buckets (id, name, public)
values ('scan-images', 'scan-images', false)
on conflict (id) do nothing;

create policy "scan_images_storage_insert_own"
  on storage.objects for insert
  with check (
    bucket_id = 'scan-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "scan_images_storage_select_own"
  on storage.objects for select
  using (
    bucket_id = 'scan-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- No update/delete storage policy for the client: images are immutable once
-- uploaded, consistent with the ~30-day unlinked-image lifecycle policy in
-- §04 (cleanup runs as a scheduled service_role job, not a client action).

# 04 — Technical Architecture, Database Design, Security Plan

## Tech stack (as specified, confirmed appropriate)
React Native + Expo + TypeScript + Expo Router (file-based nav) + TanStack Query (server state/caching) + Redux Toolkit (client/app state — used sparingly, TanStack Query should own most server data) + NativeWind (Tailwind-in-RN, needed for the design system in §06) + React Hook Form + Zod (shared validation schemas between client forms and Edge Function payloads).

## High-level architecture

```
Mobile App (Expo/RN)
  ├─ Camera/Capture layer → on-device YOLO + TFLite pre-filter (bundled, no network)
  ├─ Auth (Supabase Auth, JWT)
  ├─ Scan flow → Supabase Edge Function "orchestrate-scan"
  │      ├─ Tier 0: on-device result (already computed) attached
  │      ├─ Tier 1: Gemini Flash call (structured JSON), fed all 1–4 captured photos for multi-angle fusion
  │      ├─ Tier 2 (premium/low-confidence): parallel GPT-5-mini + Claude Sonnet calls, per-vendor timeout + circuit breaker (a failing vendor is temporarily routed around, degrading to fewer ensemble members rather than failing the scan)
  │      ├─ Arbiter step: weighted-vote / LLM-as-judge → qualitative confidence band
  │      ├─ Locality re-ranking: candidates re-weighted against USGS/Macrostrat locality data if location was shared for this scan
  │      ├─ Hallmark path (if applicable): OCR + symbol-database lookup against `reference_hallmarks`, bypassing the general vision ensemble
  │      ├─ Knowledge-base enrichment: join against Postgres reference tables (species facts, sourced from USGS/Smithsonian/RRUFF/Macrostrat sync jobs)
  │      └─ Result persisted → returned to app
  ├─ Encyclopedia (offline-first: synced reference tables cached locally via SQLite/Expo FileSystem)
  ├─ AI Gemologist chat → Edge Function, RAG over the same reference knowledge base + scan history
  └─ Professional module → inventory CRUD + PDF report generation (server-side, e.g. Edge Function + PDF lib, or a dedicated render service)

Supabase Backend
  ├─ PostgreSQL (primary data store + pgvector, HNSW-indexed from the start, for RAG embeddings over knowledge base)
  ├─ Auth (JWT, row-level security keyed on auth.uid())
  ├─ Edge Functions (Deno) — orchestration, subscription verification, PDF generation, scheduled data-sync jobs
  ├─ Storage (scan images, generated PDFs) — private buckets, signed URLs, lifecycle policy (see below)
  ├─ Rate limiting — server-side, keyed on account + device fingerprint (not account alone), with anomaly detection on scan-volume spikes per IP/device
  └─ Scheduled jobs (pg_cron or external scheduler) — periodic re-sync from USGS/Smithsonian/RRUFF/Macrostrat APIs into reference tables, with monitoring/alerting if a source API changes shape or goes down
```

**Image storage lifecycle:** scan images not linked to a `collection_items` or `inventory_items` row auto-expire after a short retention window (e.g., 30 days) — at scale, indefinitely storing every free-tier throwaway scan is pure cost with no product value. Collection/inventory-linked images are retained per the user's plan/storage quota.

**Multi-photo scans:** `scans` stores an array of image_storage_paths (2–4 photos) rather than a single path, to support the multi-angle fusion described in §03.

## Database design (PostgreSQL / Supabase)

Core tables (illustrative column sets, not exhaustive):

**users** — id (uuid, = auth.uid()), email, display_name, locale (`en`/`so`), subscription_tier (`free`/`premium`/`lifetime`/`professional`), subscription_expires_at, created_at.

**scans** — id, user_id (fk), image_storage_paths (jsonb array, 1–4 photos per scan), captured_at, specimen_category (enum: gemstone/mineral/rock/crystal/metal/jewelry/coin/meteorite/hallmark/other), location (nullable, geography type, only if user opts in; stored at full precision privately, never exposed at full precision in any shared/public context — see §05), on_device_precheck_json, ai_result_json, confidence_band (`low`/`medium`/`high`), top_candidates (jsonb array), moderation_status (`ok`/`flagged`/`review`, for basic abuse/inappropriate-content moderation on user-submitted images), created_at.

**reference_hallmarks** — id, mark_image_or_glyph_ref, country, assay_office, metal_type, purity_indicated, date_letter_system (jsonb), source_attribution — powers the dedicated hallmark OCR/lookup sub-pipeline in §03.

**scan_candidates** — id, scan_id (fk), rank, species_ref_id (fk → reference_species), model_source (`gemini`/`gpt`/`claude`/`ensemble`), raw_model_confidence (nullable float, stored but never shown to user as false precision), notes.

**reference_species** — id, common_name, scientific_name, trade_name, chemical_formula, crystal_system, mohs_hardness_min/max, specific_gravity_min/max, refractive_index_min/max, luster, transparency_options, typical_colors, common_treatments, mining_countries (jsonb), care_instructions, interesting_facts, source_attribution (jsonb — tracks which of USGS/Smithsonian/RRUFF/Macrostrat/Mindat-partnership contributed each field, for licensing auditability), last_synced_at.

**reference_media** — id, species_ref_id (fk), storage_path or external_url, license_type (`cc0`/`cc-by`/`public-domain`/`owned`), attribution_text, source (matches §03 tier-1 sources only unless partnership-cleared).

**collection_items** — id, user_id (fk), scan_id (nullable fk), custom_name, notes, tags, is_favorite, created_at — the personal specimen journal from §02.

**inventory_items** (professional tier) — id, org_id (fk to a `professional_orgs` table), scan_id (nullable fk), sku, description, weight_carats/grams, estimated_value_range, status (`in_stock`/`sold`/`consigned`), created_by, created_at.

**reports** (professional tier) — id, inventory_item_id or scan_id (fk), pdf_storage_path, generated_at, generated_by.

**subscriptions** — id, user_id (fk), source (`web_stripe`/`web_mobile_money`/`ios_iap`/`android_iap` — see §05 for why app-store IAP may be required), external_reference_id, status, current_period_end.

**chat_sessions / chat_messages** — standard conversational history, scoped per user, referenced against reference_species/reference_media for RAG citations.

All user-owned tables (`scans`, `collection_items`, `inventory_items`, `chat_sessions`) use **Row Level Security** keyed to `auth.uid()` (or org membership for professional/multi-user accounts via a join table `org_members`). Reference tables (`reference_species`, `reference_media`) are public-read, service-role-write-only (populated by scheduled sync jobs, never by client writes).

## Security plan

- **Authentication:** Supabase Auth (JWT), MFA optional for professional-tier accounts (handling higher-value inventory data).
- **Authorization:** RLS on every user-scoped table; professional/org data further scoped via an `org_members` join table with role (`owner`/`staff`) so a jeweler's staff accounts can't see other shops' inventory.
- **Subscription verification:** the mobile app **never processes payment** — it only calls a verification Edge Function that checks subscription status against the source of truth (Stripe webhook-updated `subscriptions` table, or platform IAP receipt validation — see §05 for why the "website-only" requirement needs a policy-compliant fallback). No client-side entitlement checks that can be bypassed by a jailbroken/rooted device — server-side check on every gated action.
- **API key custody:** all third-party AI API keys (OpenAI/Gemini/Claude) live only in Edge Function environment secrets, never shipped in the mobile bundle — the app calls your own orchestration endpoint, never the AI vendors directly.
- **Image handling:** images uploaded to private Storage buckets, accessed only via short-lived signed URLs; user-controlled deletion (GDPR/CCPA-style right-to-erasure) cascades scan images, results, and any derived collection/inventory entries.
- **PII minimization:** location data attached to a scan is opt-in per scan (relevant for rockhounds documenting find-locations, but sensitive — don't default to always-capture).
- **Data licensing audit trail:** the `source_attribution` field on `reference_species`/`reference_media` exists specifically so the product can prove, per field/image, which licensed source it came from — important given the mixed-licensing landscape in §03.
- **Rate limiting & abuse prevention:** per-user and per-device scan rate limits enforced server-side (not just the "5 free scans/day" product rule, but abuse-resistant limits to prevent API-cost attacks via scripted accounts).
- **Dependency/AI-vendor risk:** orchestration layer is provider-agnostic (interface, not hard-coded per vendor) so Gemini/GPT/Claude can be swapped or reweighted without a client release, given how fast vendor pricing/models are moving (see the pricing volatility already visible in §03's research).

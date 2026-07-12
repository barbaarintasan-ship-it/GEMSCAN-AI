# GemScan AI — Implementation

This repo contains two things built so far:

1. The **payment-separation architecture**: the piece of the system that enforces the locked product decision in [05-Monetization-Legal-Payments.md](05-Monetization-Legal-Payments.md) — *all payments happen only on the official website; the mobile app authenticates users and reads entitlement, and nothing more.*
2. The **AI Scan Pipeline**: the core product feature — guided multi-angle capture, on-device detection/enhancement, a modular multi-vendor cloud AI ensemble, and an honest, never-overclaiming result screen. See the Stage 1-7 breakdown below.

Full product/research context lives in the numbered docs at the repo root (start at [00-INDEX.md](00-INDEX.md)).

## Structure

```
supabase/
  migrations/
    0001_init_auth_subscriptions.sql -- profiles, subscriptions, payment_events + RLS
    0002_scan_pipeline.sql           -- scans, scan_images, scan_ai_responses, scan_candidates,
                                        scan_feedback, reference_hallmarks + scan-images storage bucket
  functions/
    _shared/entitlements.ts     -- single source of truth for tier -> feature entitlements
    verify-subscription/        -- READ-ONLY entitlement check. Called by the mobile app AND website.
    create-checkout-session/    -- WEBSITE-ONLY. Creates a Stripe Checkout session. Mobile app never calls this.
    stripe-webhook/             -- Stripe → writes subscriptions table. No client can call this directly (signature-verified).
    mobile-money-webhook/       -- Template for EVC Plus/Zaad/Sahal/eDahab gateway → same write pattern as Stripe.
    orchestrate-scan/           -- AI Scan Pipeline Stage 4-7 orchestrator (see below).
      ensemble.ts                -- Stage 5-6: weighted-confidence ensemble voting + result shaping
      providers/                 -- one adapter per AI vendor (Stage 4) — this is the modular seam;
                                     add a new vendor by adding one file + registering it in
                                     providerRegistry.ts, without touching index.ts or ensemble.ts
        types.ts, providerRegistry.ts, promptShared.ts
        onDeviceClassifier.ts    -- wraps the client's Stage 2 TFLite hint as one more ensemble vote
        geminiVision.ts, openaiVision.ts, claudeVision.ts -- general vision identification
        hallmarkOcr.ts           -- OCR + reference_hallmarks lookup (jewelry/coin/hallmark only)
        geologicalContext.ts     -- Macrostrat-based locality re-ranking (only if location supplied)
  config.toml

mobile/                          -- Expo/React Native/TypeScript app
  lib/supabase.ts                -- Supabase client (auth + read-only data access only)
  lib/auth.tsx                   -- sign up / sign in / sign out
  lib/subscription.ts            -- useSubscriptionStatus() — calls verify-subscription, nothing else
  lib/onDeviceDetection.ts       -- Stage 2: YOLO detect/crop + TFLite coarse classify (TFLite model
                                     assets not bundled yet — fails soft, see file header)
  lib/backgroundSegmentation.ts -- Stage 3 (final step): documented no-op until a segmentation
                                     model is bundled
  lib/location.ts                -- optional, client-fuzzed (~1-2km) location for geological context
  lib/scanUpload.ts              -- creates scans/scan_images rows, uploads to Storage, calls
                                     orchestrate-scan, submits Stage 7 feedback
  components/ImageProcessorGL.tsx -- Stage 1 (blur/exposure quality check) + Stage 3 (on-device
                                      white balance/exposure/sharpen) via an offscreen expo-gl surface
  components/PremiumGate.tsx     -- gates features; links OUT to the website, never sells in-app
  app/(auth)/login.tsx, register.tsx
  app/(app)/index.tsx, account.tsx
  app/(app)/scan/capture.tsx      -- Stage 1-3 guided capture flow, one angle at a time
  app/(app)/scan/results.tsx      -- Stage 6-7 result display + correct/incorrect feedback
  scripts/check-no-billing-deps.js  -- fails install/start if IAP/billing packages are ever added
```

## The AI Scan Pipeline (Stages 1-7)

1. **Guided multi-angle capture** (`app/(app)/scan/capture.tsx`) — front, back, left, right, top,
   bottom, macro, and an optional wet-specimen photo, one at a time.
2. **Automatic quality validation** (`components/ImageProcessorGL.tsx`) — a hidden on-device GL
   surface computes a Laplacian-variance sharpness estimate and mean brightness for each photo;
   blurry/too-dark/overexposed photos are rejected with a specific retake reason before the user
   can move to the next angle.
3. **On-device detection/crop** (`lib/onDeviceDetection.ts`) — YOLO-family detector output would
   crop each photo to the specimen's bounding box; ships as a wired-but-fails-soft integration
   pending a trained `.tflite` model asset (see the file header for exactly what's missing).
4. **On-device enhancement** (`components/ImageProcessorGL.tsx`) — gray-world white balance,
   exposure/contrast correction, and unsharp-mask sharpening via a GLSL shader pass, entirely
   on-device before anything is uploaded. Background segmentation (`lib/backgroundSegmentation.ts`)
   is the one enhancement step that genuinely needs a trained model rather than a shader, so it's
   a documented no-op until that model is bundled.
5. **Cloud AI ensemble** (`supabase/functions/orchestrate-scan/providers/*.ts`) — Gemini Vision,
   OpenAI Vision, and Claude Vision each independently identify the specimen; a dedicated hallmark
   OCR + reference-lookup path runs for jewelry/coins; a Macrostrat-based Geological Context Engine
   re-ranks candidates by locality if the user opted in to sharing a coarse location. Every provider
   is one file implementing a common `VisionProvider` interface — adding a new AI vendor never
   touches the orchestration or voting code.
6. **Weighted-confidence ensemble voting** (`supabase/functions/orchestrate-scan/ensemble.ts`) —
   NOT simple majority voting: each provider's vote is weighted by its base trust weight times its
   own confidence, geological context applies a bounded re-ranking boost, and the result is
   normalized by the total participating weight so a single failed vendor call doesn't depress
   every score.
7. **Honest result presentation** (`app/(app)/scan/results.tsx`) — best match, top 5 alternatives,
   why each ranked where it did, and why alternatives lost. If the best match's weighted confidence
   falls below the configured threshold, the app shows exactly *"We cannot identify this specimen
   with sufficient confidence from the available images"* plus concrete suggestions — never a
   confident-sounding guess.
8. **Full audit trail persisted** (migration `0002_scan_pipeline.sql`) — original images, enhanced
   images, every provider's raw response and latency, the final ensemble decision, timing, and
   user feedback (correct/incorrect) are all saved, closing the loop for future accuracy tuning.

Entitlement is enforced **server-side, at scan time**, not just in the UI: `orchestrate-scan` reads
the caller's subscription tier via the same `_shared/entitlements.ts` logic `verify-subscription`
uses, rejects requests once the free tier's daily scan limit is exceeded, and only runs the OpenAI/
Claude adapters for tiers with `ensembleScans` enabled (free tier still gets a real identification
from Gemini + on-device + hallmark/geological context, just not the full 3-model ensemble).

## The contract, enforced at multiple layers (not just documentation)

1. **Database (RLS):** `subscriptions` table grants `authenticated` users `SELECT` on their own row only. No `INSERT`/`UPDATE`/`DELETE` policy exists for anyone but `service_role`. A bug in the mobile app cannot grant entitlement — there is no code path that could even attempt it.
2. **Edge Functions:** `verify-subscription` is read-only by construction (no write call in the function at all). `create-checkout-session` and the webhook functions are the only code that ever calls Stripe/PayPal/mobile-money — and none of that code ships in the mobile app bundle.
3. **Mobile app dependencies:** `scripts/check-no-billing-deps.js` runs on every `npm install` and `npm start` and hard-fails if `react-native-iap`, `expo-in-app-purchases`, `react-native-purchases` (RevenueCat), or similar packages ever appear in `mobile/package.json`.
4. **Mobile app UI:** `PremiumGate.tsx` is the only "upgrade" surface in the app, and it does exactly one thing when a user isn't entitled — open `https://gemscan.ai/pricing` in the browser. There is no price list, no "Buy" button, no payment form anywhere in the app.

## App Store / Play Store policy status

See [05-Monetization-Legal-Payments.md](05-Monetization-Legal-Payments.md) for the full analysis. Summary: this model is lower-risk on **Google Play** and carries a **real, documented risk of App Store review friction on iOS** (Guideline 3.1.1). The decision to proceed with this model regardless is final and intentional — the doc lists the fallback distribution options (PWA, EU alternative distribution, TestFlight/enterprise for B2B professional customers) to have ready if iOS review is ever an issue, without changing the underlying architecture.

## Running locally

```bash
# Backend
cd supabase
supabase start
supabase db push          # applies migrations 0001 (auth/subscriptions) and 0002 (scan pipeline)
supabase functions serve  # local Edge Function dev server
# set secrets per supabase/functions/.env.example via `supabase secrets set`
# (orchestrate-scan needs GEMINI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY —
# Macrostrat needs no key)

# Mobile app
cd mobile
cp .env.example .env      # fill in your Supabase URL/anon key
npm install                # runs check-no-billing-deps.js automatically
npm start
```

## Not yet implemented

- **On-device model assets**: `mobile/lib/onDeviceDetection.ts` (Stage 2 YOLO detector + TFLite
  coarse classifier) and `mobile/lib/backgroundSegmentation.ts` (Stage 3) are fully wired into the
  capture flow but fail soft until trained `.tflite` model files are actually bundled — see each
  file's header for exactly what's expected.
- The official website and checkout system (where the payment-separation architecture above
  actually gets used) — specified in doc 05, not yet built. Per the agreed sequencing, this is next
  now that the scan pipeline is in place.
- Offline encyclopedia (300+ entries), the AI Gemologist chat, collection/journal, and the
  professional tier (inventory management, batch scanning, PDF reports) — specified in docs 02–04
  and 07, not yet built.
- Full en/so localization resource files, and the reference-data sync jobs (USGS/Smithsonian/
  RRUFF/Macrostrat ingestion into `reference_hallmarks` and the wider reference tables described in
  doc 04) — not yet built.

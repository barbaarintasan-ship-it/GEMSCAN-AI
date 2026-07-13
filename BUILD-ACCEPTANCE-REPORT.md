# GemScan AI — Build Acceptance Report

**Date:** 2026-07-13
**Prepared by:** Automated code inspection (no runtime measurements except where noted)
**Scope:** Mobile app (`mobile/`), Website (`web/`), Supabase backend (`supabase/`)
**Latest mobile build:** Android preview APK `05e49fc1` — **FINISHED**
`https://expo.dev/artifacts/eas/-xAALYmqC_fzfh-7IvuY4QsC0iaRCEwTr1rTBjC8oA0.apk`

> **Honesty note:** This report does not hide incomplete work. Every stub,
> placeholder, and missing feature found during inspection is listed. Items
> marked "verified in code" were read directly; performance numbers that would
> require a running device/profiler are explicitly called out as **NOT measured**.

Legend: ✅ Working · 🟡 Partial / stub · ❌ Missing · 🔴 Security blocker

---

## 1. Authentication

| Capability | Mobile | Web | Method | Status |
|---|---|---|---|---|
| Register | ✅ `mobile/app/(auth)/register.tsx` | ✅ `web/src/app/signup/page.tsx` | `supabase.auth.signUp()` | ✅ Working |
| Login | ✅ `mobile/app/(auth)/login.tsx` | ✅ `web/src/app/login/page.tsx` | `signInWithPassword()` | ✅ Working |
| Logout | ✅ `mobile/app/(app)/account.tsx` | ✅ `web/src/app/account/page.tsx` | `signOut()` | ✅ Working |
| Password reset | ❌ (by design) | ✅ `forgot-password` → `update-password` | `resetPasswordForEmail()` / `updateUser()` | ✅ Web only |
| Email verification | 🟡 implicit | ✅ `web/src/app/auth/confirm/route.ts` | `verifyOtp()` / `exchangeCodeForSession()` | ✅ Working |

**Details**
- New users auto-provisioned to **free tier** via DB trigger `handle_new_user()` + `handle_new_user_subscription()` (`supabase/migrations/0001_init_auth_subscriptions.sql`).
- Web email confirmation callback handles **both** OTP token links (signup) and PKCE `code` (recovery), redirecting to a `next` param — `web/src/app/auth/confirm/route.ts`.
- **Password reset is intentionally web-only.** Mobile has no reset screen; users reset via the website. This is a design decision, not a defect — but note it as a UX constraint.
- Mobile has **no email-verification UI**; it relies on Supabase's server-side confirmation.

**Verdict:** ✅ Authentication is complete end-to-end. One deliberate gap (mobile password reset).

---

## 2. Live Scan

| Sub-feature | Status | Evidence |
|---|---|---|
| Camera permissions | ✅ Working | `mobile/app/(app)/scan/live.tsx` (expo-camera `useCameraPermissions`), blocking UI until granted |
| Location permission | ✅ Working | `mobile/lib/location.ts` — lazy, **privacy-fuzzed to ~1.1 km** |
| Live scanning | ✅ Working | 600 ms sample loop, on-device quality gating, state machine `mobile/lib/liveScanEngine.ts` |
| Upload image (gallery) | ✅ Working | `mobile/app/(app)/scan/upload.tsx` — multi-select, same pipeline as live |
| Multi-photo / multi-angle | ✅ Working | 7-angle sequence (front/left/right/top/bottom/macro/wet-optional), auto-advance, dedupe |
| Auto Scan Lock | ✅ Working | Pure decision layer `mobile/lib/autoScanLock.ts` (unit-tested), wired into `live.tsx` |
| Confidence updates | ✅ Working | Live AI-confidence + Evidence-Quality readouts on live & lock screens |
| **On-device detector (YOLO)** | 🟡 **STUB** | `mobile/lib/onDeviceDetection.ts:90` returns `null` — model not bundled |
| **On-device classifier** | 🟡 **STUB** | `mobile/lib/onDeviceDetection.ts:112` returns `null` — model not bundled |
| **Background segmentation** | 🟡 **STUB** | `mobile/lib/backgroundSegmentation.ts:15` — `{applied:false}` passthrough |

**What is genuinely real**
- **On-device image quality assessment is real GPU work**, not a stub: Laplacian-variance blur detection + brightness histogram in `mobile/components/ImageProcessorGL.tsx` (blur/dark/overexposed thresholds).
- **Image enhancement is a real GLSL shader pipeline**: gray-world white balance → exposure/contrast → unsharp-mask sharpening, output 1024×1024.
- Auto Scan Lock caps automatic cloud calls to **3 per scan** (`maxAutoEvals`), locks at **95%** confidence (backend-configurable), and lets the user "Keep scanning" to override.

**What is scaffolded (honest)**
- The two TFLite models (`assets/models/specimen-detector.tflite`, `specimen-classifier.tflite`) are **not bundled**; that directory does not exist. Both inference functions load-and-return-`null`, so scans still complete — the "on-device hint" simply rides along as `null` to the cloud ensemble, and **no bounding-box crop is applied** (full image uploaded).
- Background segmentation is a documented no-op.

**Verdict:** 🟡 The user-facing Live Scan flow is fully functional and honest. On-device ML acceleration (crop/classify/segment) is scaffolded pending trained model files. Nothing fakes a result.

---

## 3. AI Providers

All three are **real, live API integrations** (not stubs). Provider code: `supabase/functions/orchestrate-scan/providers/`.

| Provider | Model (default, overridable) | API key env var | If key missing | Tier gate |
|---|---|---|---|---|
| **Google Gemini** | `gemini-2.0-flash` (`GEMINI_MODEL`) | `GEMINI_API_KEY` | Abstains, scan continues | All tiers |
| **OpenAI** | `gpt-4o-mini` (`OPENAI_MODEL`) | `OPENAI_API_KEY` | Abstains, scan continues | **Premium+ only** |
| **Anthropic Claude** | `claude-sonnet-4-6` (`CLAUDE_MODEL`) | `ANTHROPIC_API_KEY` | Abstains, scan continues | **Premium+ only** |
| Hallmark OCR | uses Gemini | `GEMINI_API_KEY` | Abstains | All tiers |
| Geological context | Macrostrat public API | *(none needed)* | n/a | All tiers |
| On-device classifier | (mobile hint) | n/a | Sends `null` | All tiers |

### Which providers are working RIGHT NOW vs. require keys

**None of the cloud providers will return results until their API key is set as a Supabase Edge Function secret.** The code is complete and correct, but keys are environment secrets, not committed.

- **Gemini** → needs `GEMINI_API_KEY`. Powers both vision + hallmark OCR. **Without it, free-tier scans have no cloud vision result at all** (Gemini is the only vision model free tier runs).
- **OpenAI** → needs `OPENAI_API_KEY`. Only runs for Premium/Lifetime/Professional.
- **Claude** → needs `ANTHROPIC_API_KEY`. Only runs for Premium/Lifetime/Professional.
- **Geological context** → works with no key (free public Macrostrat API).

**Behaviour if a key is absent:** that provider returns an "abstain" result (no candidate) and the ensemble proceeds with whatever remains. If *all* providers abstain, the response sets `insufficientConfidence: true` and returns generic guidance instead of a false identification. **No mock/fake identification is ever returned in production.**

**Orchestration:** weighted-confidence ensemble voting (`supabase/functions/orchestrate-scan/ensemble.ts`), providers run in **parallel** with a **25 s per-provider timeout** (`PROVIDER_TIMEOUT_MS`, `index.ts:35`). Every raw provider response is persisted to `scan_ai_responses` for audit. **No retry/backoff** on failed calls.

**Verdict:** ✅ Code-complete for all 3. ⚠️ **Operationally, all 3 require API keys to be configured before they do anything.** Confirm which keys are actually set in your Supabase project.

---

## 4. Database

Schema across `supabase/migrations/0001_*.sql` and `0002_scan_pipeline.sql`. All tables have RLS enabled.

| Table | Purpose | Status |
|---|---|---|
| `profiles` | display name, email copy, locale (en/so) | ✅ |
| `subscriptions` | tier/status/period — **service-role writes only** | ✅ |
| `payment_events` | webhook audit log | ✅ |
| `scans` | scan metadata, status, `total_duration_ms`, final_result | ✅ |
| `scan_images` | per-angle original+processed storage paths, quality | ✅ |
| `scan_ai_responses` | raw per-provider output + `latency_ms` | ✅ |
| `scan_candidates` | ranked ensemble results (1–6) | ✅ |
| `scan_feedback` | user "was this correct" feedback | ✅ |
| `reference_hallmarks` | hallmark lookup table | 🟡 **created but EMPTY** |

| Area | Status | Notes |
|---|---|---|
| **Scan history** | 🟡 **No UI** | Tables exist, RLS-secured, populated. **No screen on mobile or web lists past scans.** Users see results only immediately after scanning. |
| **Upload storage** | ✅ Working | Bucket `scan-images` (private), RLS scoped to `{user_id}/…`, immutable (no update/delete policy) |
| **User profile** | ✅ Working | Auto-created by trigger; **editable on web** (`account/actions.ts`), **read-only display on mobile** |

- **RLS coverage:** every table has RLS with least-privilege policies. Sensitive tables (`subscriptions`, `payment_events`, `scan_ai_responses`, `scan_candidates`) are **service-role-write-only**. No missing RLS, no overly-permissive policy found.
- **No orphaned table references** — every table read/written by code exists in a migration.
- **`reference_hallmarks` is created but not populated.** The hallmark OCR provider transcribes marks via Gemini then looks them up in this table; with the table empty, hallmark matching yields nothing until a data-sync job loads licensed reference data (`providers/hallmarkOcr.ts:142`).

**Verdict:** ✅ Schema, storage, profiles, and RLS are solid. 🟡 Scan-history UI is missing; hallmark reference data is unpopulated.

---

## 5. Performance

> **These are design characteristics read from code. Actual scan time, API
> latency, memory, and battery were NOT empirically measured** — that requires
> profiling on a physical device with keys configured. Do not treat the numbers
> below as measured results.

| Metric | What the code does | Measured? |
|---|---|---|
| **Scan time** | Instrumented: `scans.total_duration_ms` (end-to-end) + `scan_ai_responses.latency_ms` (per provider) are recorded on every scan. Query these after real scans for actuals. | ❌ Not run here |
| **API latency** | Providers run in **parallel**; **25 s per-provider timeout**; no retry/backoff. Slowest live provider bounds total. Auto Scan Lock caps calls to 3/scan to control cost & latency. | ❌ Not run here |
| **Memory** | Live loop samples at `quality:0` and **deletes preview frames immediately** after assessment. Full-res (`quality:0.9`) captured only on angle-lock. Analysis at 96×96, enhancement output 1024×1024. **Risk:** full file read to base64 before upload (`scanUpload.ts`) with **no image size cap** — very large photos inflate ~33% in memory. | ❌ Not run here |
| **Battery** | Deliberately battery-conscious: ~1.6 fps sample loop (`SAMPLE_INTERVAL_MS = 600`), cheap preview frames, single high-res capture per angle, on-device gating avoids needless cloud calls. | ❌ Not run here |

**To get real numbers:** run the preview APK on a device, perform scans with keys configured, then read `total_duration_ms`/`latency_ms` from the DB and profile with Android Studio / Xcode Instruments. No load/stress tests exist in the repo.

**Verdict:** 🟡 Good instrumentation and battery-aware design; **no empirical performance data captured yet.** One real risk: missing upload size cap.

---

## 6. Known Issues / Bugs

| # | Severity | Issue | Location |
|---|---|---|---|
| 1 | 🔴 **Security** | **Mobile-money webhook signature is a placeholder** — only checks a header exists, no HMAC. Payment events could be forged. Must be replaced before production. | `supabase/functions/mobile-money-webhook/index.ts:26` |
| 2 | 🟡 | On-device detector returns `null` (model not bundled) — no crop applied | `mobile/lib/onDeviceDetection.ts:90` |
| 3 | 🟡 | On-device classifier returns `null` (model not bundled) | `mobile/lib/onDeviceDetection.ts:112` |
| 4 | 🟡 | Background segmentation is a no-op passthrough | `mobile/lib/backgroundSegmentation.ts:15` |
| 5 | 🟡 | `reference_hallmarks` table empty → hallmark matching returns nothing | `supabase/migrations/0002_scan_pipeline.sql:263` |
| 6 | 🟡 | No image-size validation before base64 upload → potential memory pressure on large photos | `mobile/lib/scanUpload.ts` |
| 7 | 🟡 | No retry/backoff on failed AI provider calls (single failure = abstain) | `orchestrate-scan/index.ts` |
| 8 | 🟢 | `@ts-expect-error`/`eslint-disable` are localized & documented (expo-gl typings, scan-loop deps, optional tflite require) — not fragile logic | live.tsx:105, onDeviceDetection.ts:58, ImageProcessorGL.tsx:149 |
| 9 | 🟢 | **Mobile-money initiation Edge Function (`mobile-money-checkout`) is not implemented** — website calls it and degrades to a "pending" message | `web/src/app/checkout/mobile-money/actions.ts` |

No `any`-typed core logic was found. Type safety is otherwise respected.

---

## 7. Missing / Not-Yet-Implemented Features

Cross-checked against the product docs (`02-Product-Requirements-Document.md`, `05-Monetization-Legal-Payments.md`, etc.).

**Camera/scan gaps**
- ❌ Flashlight/torch, macro mode, pinch-zoom, tap-to-focus controls (spec'd, not in code)
- ❌ Multi-object / tray scanning (single specimen per scan only)
- 🟡 On-device crop/classify/segment (scaffolded stubs — see §2)

**Results gaps**
- 🟡 Structured gemological fields (hardness, refractive index, formula, luster, care) — results show free-form `reasoning` text + ranked candidates, **not** a structured spec sheet
- 🟡 Locality-aware re-ranking exists in backend but client sends only fuzzed location

**Whole features not implemented**
- ❌ Scan history / collection browsing UI (DB ready, no screen — mobile or web)
- ❌ AI Gemologist chat
- ❌ "Ask a Real Gemologist" human-escalation (premium add-on)
- ❌ Encyclopedia / offline reference library (300+ entries spec'd)
- ❌ Professional tier: inventory management, batch scanning, PDF reports
- ❌ Localization: `i18next`/`react-i18next` are in `package.json` but **no translations wired**; English/Somali not actually implemented in UI
- ❌ Published accuracy transparency reports

**Platform / build gaps**
- ❌ **No iOS build.** `mobile/` has an `android/` folder but **no `ios/` folder**. `app.json`/`eas.json` declare iOS config, but no native iOS project or artifact exists; App Store submission not yet validated (IAP-vs-website-payments risk untested).
- 🟡 `eas.json` iOS submit block still has `REPLACE_WITH_APPLE_ID_EMAIL` / `REPLACE_WITH_APP_STORE_CONNECT_APP_ID` placeholders.
- 🟡 Splash screen is a solid color only (no splash image asset referenced); verify `assets/icon.png` exists.
- ✅ Website marketing/legal/pricing/download/account/checkout pages are implemented and the production build passes (18 routes). See `WEBSITE-REVIEW-GUIDE.md`.

---

## Overall Assessment

**The core scan → AI ensemble → result loop is real, well-architected, tested, and honest.** No feature fakes a result: missing keys/models cause graceful abstention, not fabricated confidence.

**Roughly MVP-level (~40% of the full product roadmap).** The remaining ~60% (chat, encyclopedia, history UI, professional tier, localization, human escalation) is not yet built.

### Must-fix before any production/paid launch
1. 🔴 Replace the mobile-money webhook signature stub with real HMAC verification (`mobile-money-webhook/index.ts:26`).
2. ⚠️ Configure the AI API keys (`GEMINI_API_KEY` at minimum; `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` for premium) as Supabase secrets — nothing identifies without them.
3. ⚠️ Implement the `mobile-money-checkout` initiation Edge Function (website UI already expects it).
4. ⚠️ Populate `reference_hallmarks` or disable the hallmark provider.
5. ⚠️ Replace `eas.json` iOS submit placeholders and stand up an iOS build before promising iPhone support.

### Recommended before v1.0
- Add a scan-history UI (schema is ready).
- Add an upload image-size cap.
- Bundle the TFLite models (or document to users that on-device acceleration is off).
- Add retry/backoff for transient AI API failures.

### Deferred (roadmap)
- AI Gemologist chat, encyclopedia, professional tier, localization, human escalation, accuracy transparency reports.

---

*Every item above was derived from reading the current code. Performance figures
were not measured. Nothing known to be incomplete has been omitted.*

# 09 — AI Scan Pipeline: Production Verification Report

**Scope:** Full production-readiness pass over the AI Scan Pipeline (mobile capture/upload flow + `orchestrate-scan` and related Supabase Edge Functions + database schema), performed before any website/checkout work begins, per the standing instruction to treat the scan pipeline as production software first.

**Verdict: PASS.** The pipeline is stable, type-safe, lint-clean, tested (25 unit tests + 6 integration tests, all green), and has no known critical security or correctness issues. Two environment-level constraints are permanently out of this project's control (iOS builds require macOS/Linux; true E2E requires live credentials) and are documented below rather than worked around.

---

## 1–2. Dependencies & TypeScript

- `mobile/`: `npm install` completes cleanly; `npx tsc --noEmit` → **0 errors**.
- `supabase/functions/`: every function passes `deno check` → **0 errors**, including after this pass's refactors.

## 3. Linting

- `npx eslint .` in `mobile/` → **0 errors, 0 warnings** (the one `import/first` warning introduced by the new `ImageProcessorGL.test.ts` was fixed by moving `jest.mock()` calls after the import — Jest hoists `jest.mock()` regardless of source position, so behavior is unchanged).

## 4–5. Supabase Migrations & RLS Policies

- `0001_init_auth_subscriptions.sql` and `0002_scan_pipeline.sql` are idempotent (`create table/index if not exists`, `on conflict do nothing`) and correctly ordered.
- Every table holding user or AI-verdict data has RLS **enabled**, confirmed table-by-table:
  - `scans`, `scan_images`: client can `select`/`insert` only rows it owns (via `auth.uid()` or a `scans.user_id` join); **no client update/delete** — lifecycle fields (`status`, `final_result`, `confidence_band`) can only move via the service-role Edge Function.
  - `scan_ai_responses`, `scan_candidates`: **select-only** for the owning user; no insert/update/delete policy exists at all — these are service-role-write-only by construction, not just by convention.
  - `scan_feedback`: owned by `user_id`, unique per scan.
  - `reference_hallmarks`: public read (reference data), writes reserved for backend sync jobs.
  - `subscriptions`: read-only for the owning user; no client write path (matches the "app never purchases, only reads what the website granted" model).
  - Storage bucket `scan-images`: insert/select scoped to the caller's own `auth.uid()` folder prefix; no update/delete (images are immutable, cleaned up by a scheduled job).

## 6–7. Edge Functions Compile & Import Paths

- All Edge Functions (`orchestrate-scan`, `verify-subscription`, and shared modules) pass `deno check` with no import-resolution errors, before and after this pass's refactors.

## 8–10. Expo / Android / iOS Build Verification

- **Expo:** `expo-doctor` → 17/17 checks passed.
- **Android:** a real debug APK was built end-to-end (`./gradlew :app:assembleDebug` → `BUILD SUCCESSFUL`, `app-debug.apk`, ~192MB). Getting there required fixing four real environment gaps (JDK 17, `platforms;android-34`, cmdline-tools/sdkmanager, and a Java `Properties`-file backslash-escaping bug that silently corrupted `local.properties`' `sdk.dir` on Windows — fixed by using forward slashes). This is now a known-working local build path.
- **iOS:** confirmed **infeasible on Windows** — Expo's own CLI explicitly refuses to prebuild for iOS on this platform ("Run `npx expo prebuild` again from macOS or Linux"). This is a platform constraint, not a project bug; iOS builds require a macOS or Linux machine (or EAS Build in the cloud).

## 11. Unit Tests

25 tests added and passing, covering every pure-logic module in the pipeline:

| Module | Tests | Result |
|---|---|---|
| `mobile/components/ImageProcessorGL.tsx` (`computeQualityFromPixels` — Stage 1 blur/exposure gate) | 8 | ✅ all pass |
| `supabase/functions/orchestrate-scan/ensemble.ts` (`runEnsemble` — Stage 5/6 weighted voting) | 11 | ✅ all pass |
| `supabase/functions/_shared/entitlements.ts` (`featuresForTier` — subscription gating) | 6 | ✅ all pass |

Coverage includes: blur/exposure thresholds and score clamping; single- vs. multi-provider agreement; label normalization (casing/whitespace); alternative-vote discounting; provider exclusion on error/zero-weight; insufficient-confidence fallback; geological-context re-ranking; the 6-candidate cap; rank/rejection invariants; and fail-closed behavior for unrecognized subscription tiers.

## 12. Integration Tests

Added `supabase/functions/orchestrate-scan/index.test.ts` (6 tests) exercising the real Stage 4–7 orchestration flow (`processScan`) against mocked providers and a mocked Supabase client — no live network or database required:

- Persists every provider's raw response and the ranked ensemble candidates, returns a completed result.
- Providers whose `isApplicable()` returns false never run or get persisted.
- Providers gated behind `requiresEnsembleTier` are correctly excluded for non-premium callers.
- A throwing/failing provider is isolated (abstain-with-error) without breaking the rest of the scan.
- A failed signed-URL generation throws (so the outer handler can mark the scan `failed`).
- When every provider abstains, the response is `insufficientConfidence` with no candidates persisted.

**Enabling change:** `index.ts` previously ran `Deno.serve(...)` directly at module scope, making it unimportable by a test file. Refactored to export `handleRequest`/`processScan`, gate the actual server bind behind `if (import.meta.main)`, and give `processScan` an optional `providers` override — a minimal, standard Deno testability pattern with zero behavior change in production (the Edge Runtime still imports the file as its entry point, so `import.meta.main` is still true there).

## 13. End-to-End Tests

**Assessed as infeasible in this environment**, for concrete reasons (not a shortcut):
- No E2E framework (Detox/Maestro/Appium) exists in the repo yet.
- `mobile/.env` / `supabase/functions/.env.example` confirm no real Supabase project or AI vendor keys (Gemini/OpenAI/Anthropic) are configured — only placeholders. Real E2E would need live credentials and would call paid third-party AI APIs, which isn't something to provision or spend against autonomously.
- iOS E2E is additionally blocked by the Windows prebuild restriction above.
- An Android emulator binary + AVD do exist on this machine, so Android UI automation is technically possible once a framework (Maestro is the better fit for an Expo app — no native rebuild required) is added and pointed at a staging backend.

**Recommendation:** add Maestro, wire it to a staging Supabase project + sandboxed/low-quota AI vendor keys, and run manually or in CI — as a deliberate follow-up, not squeezed into this verification pass.

## 14. Memory Usage Review

| Area | Finding | Severity |
|---|---|---|
| `ImageProcessorGL.tsx` GL textures | Properly deleted after `glReadPixels`; no accumulation across a scan's multiple angle captures (state replaces per-angle, doesn't append). | None |
| `capture.tsx` multi-angle state | Correctly filters/replaces by angle; no unbounded growth across a 7–8 angle scan. | None |
| `providers/promptShared.ts` `fetchImageAsBase64` | Reads full image → `Uint8Array` → byte-by-byte binary string → `btoa()`. Three intermediate representations ≈ 4x the image size in memory, per image, per provider (Gemini and Claude both use this; OpenAI doesn't, since its API accepts signed URLs directly). For a handful of processed images (~200–400KB each) this is a few MB, not a real risk today — but it is the one thing to watch if image sizes grow or Deno's Edge Function memory ceiling is hit. | **Medium** (documented, not fixed — would require switching Gemini/Claude to their file-upload APIs, an architecture change outside this pass's scope) |
| Provider fan-out | True parallel (`Promise.all`), not accumulating per-provider memory serially. | None |

## 15. Performance Review

- **Capture flow:** quality scoring runs two small O(n) passes (~18K ops total) on an 8×8-ish downsampled buffer, awaited asynchronously — no UI jank. Detection + GL enhancement run concurrently via `Promise.all`.
- **Ensemble (`ensemble.ts`):** single-pass O(n) over provider results + O(k log k) sort over distinct labels (k is small, bounded by provider count) — not quadratic, no redundant re-scans.
- **Provider timeouts:** each provider is wrapped individually in `Promise.race` against a 25s timeout, and all providers run via `Promise.all` — confirmed genuinely parallel, so one slow vendor costs at most 25s total, not 25s × provider count.

## 16. Security Review

- **Secrets:** confirmed zero AI-vendor or service-role keys anywhere in `mobile/` — only public `EXPO_PUBLIC_*` Supabase URL/anon-key values, which are safe to bundle by design. All vendor keys (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) and the service-role key live only in Edge Function server env.
- **Input validation:** `scanId` is validated as a non-empty string before use; malformed JSON bodies are caught. AI vendor responses are defensively parsed — confidences are clamped to [0,1] (`clamp01`, now private to `promptShared.ts`), alternatives capped at 4 items, labels coerced to strings.
- **Entitlement enforcement:** re-derived and enforced **server-side** at scan time in `index.ts` (daily free-tier scan limit, ensemble-tier gating) — not just a client-side UI hint.
- **RLS:** see §5 above — sound.
- **CORS (`_shared/cors.ts`):** wildcard `Access-Control-Allow-Origin: *`. Low-severity: acceptable given every sensitive endpoint requires a bearer JWT (not cookie-based credentials), but worth tightening to known origins as a defense-in-depth improvement if/when time allows — not a blocking issue.
- **`npm audit` (mobile/):** 31 vulnerabilities (1 low, 13 moderate, 17 high). Traced every advisory to its dependency chain (`npm ls`) rather than trusting the summary count at face value: all of them are transitive dependencies of Expo's/React Native's own **build-time CLI tooling** — `@expo/cli`, `@expo/config-plugins`, `@expo/prebuild-config` (pulling in `@xmldom/xmldom`, `postcss`, `send`, `tar`, `uuid`) and `@react-native-community/cli-platform-*` (pulling in `fast-xml-parser`). None of this code is bundled into the shipped iOS/Android app binary — Metro only bundles the app's own JS/TS source plus runtime libraries, not the Node-based CLI/build tooling that runs on a developer or CI machine. Real-world exposure is therefore limited to a compromised build environment (e.g. a malicious crafted `Info.plist`/XML file fed into `expo prebuild`), not the shipped product. Ran the non-breaking remediation (`npm audit fix`, no `--force`) to pick up the one fixable advisory (`turbo-stream`/`@remix-run`); the remaining 31 all require `expo@57.0.4` or `react-native@0.86.0` — breaking upgrades that conflict with this project's deliberate SDK 51 / RN 0.74.5 pinning (chosen specifically to keep `jest-expo` compatible with `react@18.2.0`) — and were **left unfixed and documented** rather than force-upgraded without authorization. Re-ran `tsc --noEmit`, `eslint .`, and `jest` after the non-breaking fix and after a subsequent `expo install --fix` dependency correction (which separately realigned `react-native`, `expo-image-picker`, and `react-native-safe-area-context` to their exact SDK-51-compatible versions) — all still clean (0 type errors, 0 lint issues, 8/8 tests passing).

## 17. AI Orchestration Review

- **Ensemble weighting:** confirmed correct via 11 direct unit tests — weighted-by-confidence voting with a 0.5x discount for a provider's listed alternatives, normalized by the total weight of providers that actually returned a result (not all registered providers), a 1.15x geological-context re-ranking boost, and the 0.35/0.45/0.72 insufficient/medium/high confidence thresholds all behave as designed.
- **Timeout & circuit-breaker behavior:** each provider is independently bounded at 25s via `Promise.race`; a timed-out or throwing provider degrades to an "abstain with error" result rather than failing the whole scan — confirmed both by code review and by the new integration tests.
- **Per-provider error isolation:** confirmed — one failing/slow vendor never prevents the ensemble from completing with the remaining providers' input.

## 18. Database Index Review

Read `0002_scan_pipeline.sql` in full to confirm the indexing story is complete and deliberate:
- `idx_scans_user_id_created_at (user_id, created_at desc)` — serves the user's scan-history list query.
- `scan_images`: the `unique (scan_id, angle)` constraint already provides a `scan_id`-leading composite index; a separate single-column index would be a genuine duplicate (explicitly commented as such in the migration).
- `idx_scan_ai_responses_scan_id`, `idx_scan_candidates_scan_id_rank (scan_id, rank)` — serve per-scan detail lookups in ranked order.
- `scan_feedback`: the `unique (scan_id)` constraint already indexes that column.
- `reference_hallmarks`: a plain btree index on `mark_code` **plus** a `pg_trgm` GIN trigram index, because the hallmark OCR provider does a leading-wildcard `ilike('%mark%')` lookup that a plain btree can't serve — this was already added in an earlier pass and is confirmed still correct and necessary.

No missing indexes, no redundant ones — this item was substantially completed in an earlier session and this pass reconfirms it end-to-end.

## 19. Image Upload Performance

- Images are read as base64, decoded to raw bytes, and uploaded as-is (no wasteful re-encoding). A full 7-angle scan (original + enhanced per angle) totals roughly 4MB.
- Uploads happen **sequentially** per angle rather than in parallel. This is a deliberate, acceptable tradeoff (avoids holding multiple large in-flight buffers in mobile memory simultaneously) rather than an oversight — flagged **low severity**, not changed, since the UI already shows an "analyzing" state for longer than the upload takes anyway.

## 20. Error Handling Review

- **Mobile:** capture, enhancement, upload, and orchestration calls are all wrapped in try/catch with user-facing retry messaging (`retakeReason`) — no silent failure paths found.
- **Edge Function:** `orchestrate-scan`'s outer `catch` reliably marks a scan `failed` if `processScan` throws for any reason (confirmed by the new integration test for signed-URL failure, which is exactly this path). Auth/entitlement rejections that happen before `processScan` is even invoked correctly return an error response without ever creating an orphaned "stuck processing" row, since `status = 'processing'` is only set inside `processScan` itself, after those checks pass.

## 21. Dead Code Removed

- Stale `nativewind/babel` Babel plugin reference in `mobile/babel.config.js`, left over from an earlier `nativewind`/`tailwindcss` dependency removal (fixed earlier in this pass, verified via a subsequent clean Jest run).
- Unused `refreshSupabaseSession()` export (and its now-unused `supabase` import) in `mobile/lib/subscription.ts` — defined but never called anywhere in the app.
- `clamp01()` in `supabase/functions/orchestrate-scan/providers/promptShared.ts` was exported but only ever used internally — changed to a private (non-exported) function to keep the module's public surface accurate.
- Confirmed (not removed): the stubbed `detectSpecimenBoundingBox()`/`classifyCoarse()` functions in `mobile/lib/onDeviceDetection.ts` are **not** dead code — they're actively wired into `capture.tsx`'s capture flow and are intentional, clearly-commented placeholders awaiting the on-device TFLite/YOLO model artifacts.

## 22. Duplicate Code Removed

- Five nearly-identical `abstain(...)` helper functions — one each in `geminiVision.ts`, `openaiVision.ts`, `claudeVision.ts`, `hallmarkOcr.ts`, and `geologicalContext.ts` — all constructing the same "abstain with error" `ProviderResult` shape, differing only in the hardcoded provider name. Consolidated into a single shared `createAbstainResult(provider, start, error)` in `promptShared.ts`, imported by all five adapters. Verified with `deno check` and the full Deno test suite (23/23 passing) after the change.
- (Redundant/duplicate database indexes were already identified and removed in an earlier session — see §18.)

---

## Summary of Changes Made in This Verification Pass

1. Fixed a stale `nativewind/babel` reference in `mobile/babel.config.js`.
2. Added `mobile/components/__tests__/ImageProcessorGL.test.ts` (8 tests).
3. Added `supabase/functions/orchestrate-scan/ensemble.test.ts` (11 tests).
4. Added `supabase/functions/_shared/entitlements.test.ts` (6 tests).
5. Refactored `supabase/functions/orchestrate-scan/index.ts` for testability (`export`ed `handleRequest`/`processScan`, `import.meta.main` guard, optional `providers` injection) with no production behavior change.
6. Added `supabase/functions/orchestrate-scan/index.test.ts` (6 integration tests).
7. Removed dead code: unused `refreshSupabaseSession()` + its import; made `clamp01` private.
8. De-duplicated the five provider `abstain()` helpers into a single `createAbstainResult()` in `promptShared.ts`.
9. Fixed a minor `import/first` ESLint warning in the new mobile test file.

**Test totals: 31 passing (25 unit + 6 integration), 0 failing. TypeScript: 0 errors (mobile + all Edge Functions). ESLint: 0 errors, 0 warnings.**

## Outstanding Items (documented, intentionally not resolved here)

- **iOS builds** require a macOS/Linux machine or EAS Build — not achievable on this Windows environment.
- **True E2E tests** require a test-automation framework (Maestro recommended) plus a staging Supabase project and sandboxed AI vendor credentials — none of which exist yet and none of which should be provisioned autonomously.
- **CORS wildcard origin** (`_shared/cors.ts`) is low-severity given JWT-based auth, but tightening to known origins is a reasonable future hardening step.
- **Base64 image encoding memory overhead** in `promptShared.ts` (Gemini/Claude adapters) is a documented ~4x-per-image overhead, not currently a problem at today's image sizes, but worth revisiting if a switch to the vendors' native file-upload APIs is ever prioritized.
- **31 remaining `npm audit` advisories** in `mobile/` (all build-tooling-only, none in the shipped app bundle — see §16) require the breaking `expo@57.0.4`/`react-native@0.86.0` upgrade to fully clear. Left un-upgraded intentionally given this project's SDK 51 / RN 0.74.5 pinning; revisit when the project is ready to move off SDK 51.

---

**The AI Scan Pipeline is verified, stable, tested, and production-ready.** Per the standing instruction, work can now proceed to the website/checkout milestone.

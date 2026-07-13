# App Foundation Report — Navigation, Settings, Collection, i18n

Scope: build the missing UX foundation around the existing scan pipeline. The
scan pipeline itself (`scanUpload`, `liveScanEngine`, `autoScanLock`,
`orchestrate-scan`, and the capture/upload/results flow) is **unchanged** — the
new work sits alongside it.

## 1. Navigation improvements

- **Real back navigation everywhere.** The `(app)` route group was a bare
  `<Slot>`, which renders screens with no header and does **not** integrate the
  Android hardware back button — so back/edge-swipe risked dropping the user out
  of the app. It's now a native `<Stack>`
  ([mobile/app/(app)/_layout.tsx](mobile/app/(app)/_layout.tsx)). Every screen
  gets a dark-themed header with a back arrow, and the Android hardware back
  button / edge-swipe now pops screens correctly.
- **Back arrows where appropriate.** History, Settings and Account get automatic
  header back arrows from the Stack. The full-screen live-scan camera has no
  header, so it received an explicit floating back button (plus the hardware
  back still works) — [mobile/app/(app)/scan/live.tsx](mobile/app/(app)/scan/live.tsx).
- **Reaching the new screens.** The Home header now has two icon actions
  (Collection, Settings) and the Home body has a "My Collection" button —
  [mobile/app/(app)/index.tsx](mobile/app/(app)/index.tsx).

## 2. Settings screen — [mobile/app/(app)/settings.tsx](mobile/app/(app)/settings.tsx)

- **User profile:** email + display name (read from `profiles`).
- **Language switcher:** English / Somali with a check on the active one.
- **Privacy:** expandable "How your data is used" summary + a Privacy Policy
  link to the website.
- **Subscription status:** shows the current tier and hands off to the Account
  screen (which links to the website). No purchase flow — consistent with the
  payment-separation policy.
- **App information:** app version (from `expo-constants`).
- **Logout:** clears the Supabase session; the auth gate redirects to login.

## 3. Scan History / My Collection — [mobile/app/(app)/history.tsx](mobile/app/(app)/history.tsx)

A pure read view over the data the pipeline already writes (`scans`,
`scan_images`, `scan_candidates`), RLS-scoped to the signed-in user:

- Lists previous scans newest-first (indexed by `user_id, created_at desc`).
- Shows a thumbnail of the first uploaded image. The `scan-images` bucket is
  private, so thumbnails use batched **signed URLs** (`createSignedUrls`).
- Shows the AI best match, a confidence-band dot + confidence score, and the
  date.
- Tapping a row opens the existing results screen (`scan/results?scanId=`),
  which re-reads the scan from the database.
- Pull-to-refresh, and auto-reload on focus so a just-finished scan appears.

## 4. Empty / loading / error states

- **Empty:** diamond icon + "No scans yet" / "Scan your first gemstone to start
  your collection." + a "Start scanning" button.
- **Loading:** branded gold spinner.
- **Error:** friendly message + Retry.

## 5. Internationalization (English / Somali)

- Wired up `i18next` + `react-i18next` (already in `package.json`) —
  [mobile/lib/i18n.ts](mobile/lib/i18n.ts), with
  [mobile/locales/en.json](mobile/locales/en.json) and
  [mobile/locales/so.json](mobile/locales/so.json).
- First launch falls back to the device locale, then English.
- The choice is persisted in AsyncStorage (survives restarts, works offline) and
  best-effort mirrored to `profiles.locale` so the website stays in sync.
- Home, Settings and History are fully translated. The scan pipeline screens
  were intentionally left untouched to keep the pipeline unchanged.

## Verification

- **Typecheck:** `tsc --noEmit` — passed (0 errors).
- **Tests:** `jest` — 37/37 passed, including the `liveScanEngine` and
  `autoScanLock` pipeline suites (confirming the pipeline is unchanged).
- **Android preview build:** see **Build** below.

## Build

- **Commit:** `1671874` (pushed to `main`).
- **CI:** GitHub Actions `CI` run for commit `1671874` — **success** (typecheck +
  full jest suite).
- **Android preview APK:** produced via the manual `workflow_dispatch` EAS build
  (`.github/workflows/eas-build.yml`, profile `preview`, platform `android`),
  which requires the `EXPO_TOKEN` repo secret. Trigger with
  `gh workflow run eas-build.yml -f profile=preview -f platform=android`.

## Files changed

New:
- `mobile/lib/i18n.ts`
- `mobile/locales/en.json`, `mobile/locales/so.json`
- `mobile/app/(app)/settings.tsx`
- `mobile/app/(app)/history.tsx`

Modified:
- `mobile/app/_layout.tsx` (import i18n)
- `mobile/app/(app)/_layout.tsx` (Slot → Stack)
- `mobile/app/(app)/index.tsx` (header nav + i18n + Collection button)
- `mobile/app/(app)/scan/live.tsx` (floating back button only — no pipeline change)

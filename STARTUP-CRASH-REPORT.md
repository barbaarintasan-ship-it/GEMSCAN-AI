# GemScan AI — Startup Crash Report

**Date:** 2026-07-13
**Severity:** 🔴 Release-blocking (app crashes immediately on launch)
**Platform affected:** Android preview APK (build `05e49fc1`) — and would affect **any** standalone build (preview/production, Android or iOS)
**Status:** ✅ Root cause identified, fixed, and **verified on-device**. The fixed build launches to the sign-up/login screen with zero startup errors.

---

## 1. Summary

The Android preview APK installed correctly but crashed instantly on launch (white
screen → close). This was **not** a native/Gradle problem (the build succeeded and
installed) — it was a **JavaScript exception thrown during module initialization**,
before the first screen could render.

**Root cause:** The Supabase client module throws at import time if
`EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` are missing. Those
values live only in `mobile/.env`, which is **git-ignored**. EAS Build archives
the project through git and there is **no `.easignore`**, so `.env` was **never
uploaded to the build** and the `EXPO_PUBLIC_*` variables were **undefined at
build time**. Expo inlines `EXPO_PUBLIC_*` at build time; with nothing to inline,
the guard threw and the JS bundle crashed on startup.

---

## 2. Root Cause Analysis

### The throwing module
`mobile/lib/supabase.ts` (lines 14–22):

```ts
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY. " +
      "Set these in mobile/.env (see mobile/.env.example).",
  );
}
```

This `throw` runs at **module evaluation time**, not inside a function.

### The startup import chain (why it crashes before any UI)
```
package.json  "main": "expo-router/entry"
   └─ app/_layout.tsx        (root layout)   imports AuthProvider …
        └─ lib/auth.tsx                      imports { supabase } …
             └─ lib/supabase.ts   ← throws here at import time
```
Because the root layout is the very first module Expo Router evaluates, the throw
happens before React renders anything → **immediate crash on launch**.

### Why the variables were missing in the build
- `EXPO_PUBLIC_*` env vars are **inlined at build time** by Expo's Metro config.
  Their source is the environment of the build process (a committed `.env`, an
  `env` block in `eas.json`, or EAS-hosted environment variables).
- `mobile/.env` holds the values — but `git check-ignore mobile/.env` confirms it
  is **git-ignored**.
- There is **no `mobile/.easignore`**, so EAS Build used git file selection and
  **excluded `.env`**.
- The first build's log had **no** "Environment variables loaded …" line, and
  explicitly stated: *"No environment variables … found for the 'preview'
  environment on EAS."* → nothing was inlined → guard threw.

### Suspects investigated and ruled out
| Checked | Finding |
|---|---|
| **AndroidManifest** | Valid; built & installed fine. OTA meta-data present. Not the cause. |
| **app.json** | Valid. `slug`/`owner`/`runtimeVersion` correct after earlier fixes. Not the cause. |
| **Expo config** | Router entry + plugins fine. Not the cause. |
| **Native modules** | `react-native-fast-tflite` is loaded **lazily** via optional `require` in `onDeviceDetection.ts`, not at startup. Not the cause. |
| **Splash screen** | Solid-color splash; renders fine, not involved in the crash. |
| **OTA Updates** | `EXPO_UPDATES_LAUNCH_WAIT_MS=0` → updates never block launch; loads embedded bundle immediately. Not the cause. |
| **Sentry monitoring** | `lib/monitoring.ts` is a **safe no-op** when `EXPO_PUBLIC_SENTRY_DSN` is unset — it returns, never throws. Not the cause. |
| **Environment variables** | ✅ **ROOT CAUSE** — `EXPO_PUBLIC_SUPABASE_*` absent from the build. |
| **Supabase initialization** | The consequence: `supabase.ts` throws at import when those vars are absent. |
| **Other startup throws** | Grep confirmed `supabase.ts:18` is the **only** module-load `throw` in `mobile/lib`. |

---

## 3. Fix Applied

Embed the **public** `EXPO_PUBLIC_*` values directly into the EAS build profiles so
they are inlined at build time regardless of the git-ignored `.env`.

> These are public by design — the Supabase URL and the **publishable/anon** key
> are meant to ship in the client; access is protected server-side by Row Level
> Security. `mobile/.env` itself documents them as "safe to ship in the mobile
> bundle." Committing them to `eas.json` is the standard, reproducible approach
> and exposes nothing that isn't already in the shipped bundle.

### Files changed
| File | Change |
|---|---|
| `mobile/eas.json` | Added an `env` block with `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, and `EXPO_PUBLIC_SUPABASE_FUNCTIONS_URL` to the **development**, **preview**, and **production** build profiles. |

Example (preview profile):
```json
"preview": {
  "distribution": "internal",
  "channel": "preview",
  "env": {
    "EXPO_PUBLIC_SUPABASE_URL": "https://znqkzgswvhbkhxldbbld.supabase.co",
    "EXPO_PUBLIC_SUPABASE_ANON_KEY": "sb_publishable_tw-dAV4QosRuHR9WLWMelg_B-ZWw7ah",
    "EXPO_PUBLIC_SUPABASE_FUNCTIONS_URL": "https://znqkzgswvhbkhxldbbld.functions.supabase.co"
  },
  "android": { "buildType": "apk" }
}
```

Also included `EXPO_PUBLIC_SUPABASE_FUNCTIONS_URL` because `lib/subscription.ts` and
`lib/scanUpload.ts` read it with a non-null assertion; without it those features
would fail at runtime (a latent second bug) even once the app launched.

### What was intentionally NOT changed
- The `throw` guard in `supabase.ts` was **kept**. It is correct defensive behavior;
  the real defect was the build missing its env, not the guard. Removing it would
  only hide misconfiguration.
- No application/feature code was modified (per the instruction not to develop new
  features while this is open).

---

## 4. Verification

This was verified two ways: (1) the crash was **reproduced** on an Android emulator
from the original APK to capture the exact stack trace, and (2) the fixed APK was
**installed and launched** on the same emulator and confirmed to reach the sign-up
screen with no errors. No guessing — both directions are backed by real logcat.

- **Crashing build:** `05e49fc1-cfbb-4da3-80c6-13cf147edbf5` (no env vars inlined)
- **Fixed build:**   `b0947644-8c67-4517-9140-3d5b76b83c05` (env vars inlined) — **FINISHED**
- **Emulator:** `emulator-5554` (AVD `Medium_Phone_API_36.1`), Hermes JS engine

### 4a. BEFORE — reproduced crash from the original APK (real logcat)
Installed `05e49fc1`, cleared logcat, launched `ai.gemscan.app/.MainActivity`.
The process threw at JS module-load and **died back to the launcher**:
```
E ReactNativeJS: Error: Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY.
                 Set these in mobile/.env ..., js engine: hermes
E ReactNativeJS: TypeError: Cannot read property 'ErrorBoundary' of undefined
                 ... in ContextNavigator, in ExpoRoot, in App
E AndroidRuntime: Process: ai.gemscan.app, PID: 9740
E AndroidRuntime: com.facebook.react.common.JavascriptException: Error: Missing
                 EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY. ...,
                 js engine: hermes, stack:
E AndroidRuntime:   useInitializeExpoRouter@1:856510
I ActivityManager: Process ai.gemscan.app (pid 9740) has died
```
- **Exact exception:** `com.facebook.react.common.JavascriptException`
- **Exact source:** the `throw new Error("Missing EXPO_PUBLIC_SUPABASE_URL / …")`
  in `mobile/lib/supabase.ts` (module-load guard, line 18)
- **Propagation path:** `supabase.ts` throw → evaluated during expo-router's
  `useInitializeExpoRouter` → `ContextNavigator` then fails with the secondary
  `Cannot read property 'ErrorBoundary' of undefined` → process dies.

This is definitive proof of the root cause — not inference.

### 4b. Build-time proof (fixed build)
The fixed build's log prints — where the crashing build printed nothing:
```
Environment variables loaded from the "preview" build profile "env" configuration:
  EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY, EXPO_PUBLIC_SUPABASE_FUNCTIONS_URL.
```
The variables are now inlined into the bundle, so the `supabase.ts` guard passes.

### 4c. AFTER — fixed APK launches cleanly (real logcat + on-screen)
Installed `b0947644`, cleared logcat, launched `ai.gemscan.app/.MainActivity`:
- **Process stays alive:** `pidof ai.gemscan.app` → live PID (the crashing build's
  process died within ~2s; this one persists).
- **Foreground activity holds:** `dumpsys activity` →
  `ResumedActivity: ai.gemscan.app/.MainActivity` (did **not** fall back to the launcher).
- **Zero startup errors:** grepping logcat for
  `Missing EXPO_PUBLIC | JavascriptException | has died | FATAL` returns **nothing**.
- **UI renders:** the app reaches the **"Create your account"** sign-up screen
  (Email + Password fields, "Sign up" button, "Already have an account? Log in").
  Screenshot saved at `mobile/launch-screenshot3.png`.

The startup crash is completely eliminated: the exact exception that killed the
original build no longer appears, the process survives, and the first real screen
renders.

### Final check on your physical device (optional — already proven on emulator)
1. Install the fixed APK: `https://expo.dev/artifacts/eas/sLzJDLfwRLp3jmyoAVHVYhVXkDOD_KC76SI-tYVHwEA.apk`
2. Launch it — it should reach the "Create your account" screen (as above).
3. Optional: `adb logcat | grep -i "ReactNativeJS\|EXPO_PUBLIC\|Supabase"` should show
   **no** "Missing EXPO_PUBLIC_SUPABASE_*" error.

---

## 5. Recommendations (follow-up, not blocking)

1. **Add a `mobile/.easignore`** (or keep the `eas.json` env block as the single
   source of truth) so build-time configuration is explicit and never depends on a
   git-ignored file again.
2. **Fail fast in CI:** add a check that every `EXPO_PUBLIC_*` referenced with `!`
   in code has a value provided by the active build profile, so a missing var is
   caught at build time rather than on a user's device.
3. When a real **Sentry** project exists, wire `EXPO_PUBLIC_SENTRY_DSN` into the
   same `env` blocks so startup crashes like this are reported automatically.

---

*Root cause: build shipped without `EXPO_PUBLIC_SUPABASE_*`, so the Supabase client
threw `com.facebook.react.common.JavascriptException` at import (mobile/lib/supabase.ts:18,
via expo-router's `useInitializeExpoRouter`) and crashed the app on launch. Fix: inline
those public values via `eas.json` build-profile `env`. Verified end-to-end: crash
reproduced from the original APK on an emulator (captured stack trace), and the fixed
build `b0947644` installed and launched cleanly to the "Create your account" screen
with zero startup errors.*

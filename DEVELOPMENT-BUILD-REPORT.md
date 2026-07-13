# GemScan AI — Development Build Report

How to build, install, and test **every** GemScan AI feature on your own phone
during development, using Expo + EAS. This covers the Live Scan, Upload, and the
new Intelligent Auto Scan Lock features end‑to‑end.

> **No production build is created by this setup.** Everything here targets the
> `development` and `preview` profiles only. Production/store submission is left
> configured-but-untriggered.

---

## 0. What was wired up

| Item | Where | Value |
|---|---|---|
| Expo Project ID | `mobile/app.json` → `extra.eas.projectId` | `d24307ed-5428-4bbc-97ba-efd4a426856b` |
| OTA update URL | `mobile/app.json` → `updates.url` | `https://u.expo.dev/d24307ed-5428-4bbc-97ba-efd4a426856b` |
| Runtime version policy | `mobile/app.json` → `runtimeVersion.policy` | `appVersion` (currently `0.1.0`) |
| `expo-updates` runtime | `mobile/package.json` | `~0.25.28` (SDK 51 compatible) |
| Android OTA meta-data | `mobile/android/app/src/main/AndroidManifest.xml` | `ENABLED=true`, `EXPO_UPDATE_URL`, `EXPO_RUNTIME_VERSION=0.1.0` |
| EAS build profiles | `mobile/eas.json` | `development`, `development-simulator`, `preview` (+ `production`, untriggered) |
| TestFlight submit | `mobile/eas.json` → `submit.preview.ios` / `submit.production.ios` | placeholders for Apple ID + ASC App ID |

**Why the Android manifest was edited by hand:** this project commits a native
`android/` folder (a "bare"/CNG workflow), so EAS Build does **not** re-run
prebuild for Android and will not sync app-config-only fields. The OTA meta-data
was therefore written directly into the committed manifest. iOS has **no**
committed `ios/` folder, so EAS prebuilds it from `app.json` and its OTA config
is applied automatically at build time — nothing to hand-edit for iOS.

---

## 1. One-time prerequisites (on your computer)

```bash
# Node 20+ recommended (matches CI)
npm install -g eas-cli          # the EAS command-line tool
cd mobile
npm install                     # install project deps (runs the no-billing guard)
eas login                       # sign in to the Expo account that OWNS the project
eas whoami                      # confirm you're logged in
```

The project is already connected via the Project ID in `app.json`, so you do
**not** need to run `eas init` again. If EAS ever asks to link, choose the
existing project `d24307ed-5428-4bbc-97ba-efd4a426856b`.

> The account you log in as must be the owner/member of that Expo project, or
> builds will be rejected with a project-access error.

---

## 2. Build a **Development** build for your Android phone (primary path)

The development profile produces a **dev client** APK: your JavaScript is served
live from Metro on your computer, so you can hot-reload and test features
instantly without rebuilding the app.

```bash
cd mobile
eas build --profile development --platform android
```

- EAS builds an **APK** (not an AAB), `distribution: internal`, `channel:
  development`, `developmentClient: true`.
- When it finishes, EAS prints a URL + QR code. On your phone, open the link and
  install the APK (allow "install from unknown sources" if prompted).

Then start the dev server and connect your phone:

```bash
cd mobile
npx expo start --dev-client
```

Open the **GemScan AI (dev)** app on your phone → it will show the running dev
server (same Wi‑Fi), or scan the QR from the terminal. The app boots straight
into your latest local code.

### Android emulator alternative
If you use an Android emulator instead of a physical phone, the same
`development` APK installs into it — drag-and-drop the APK onto the emulator, or
`adb install <file>.apk`.

---

## 3. Build a **Development** build for iPhone

iOS dev builds must be signed for your specific device.

```bash
cd mobile
eas device:create          # register your iPhone (one-time; follow the link/QR)
eas build --profile development --platform ios
```

Install the resulting build on the registered iPhone, then `npx expo start
--dev-client` exactly as on Android.

- **Mac + Simulator only?** Use the extra profile:
  `eas build --profile development-simulator --platform ios` (builds a
  Simulator-compatible app, no device registration needed).

---

## 4. Live testing loop (how you actually test each feature)

Once a dev build is installed once, you rarely rebuild. Day-to-day:

```bash
cd mobile
npx expo start --dev-client        # start Metro
# edit code → save → app hot-reloads on the phone
```

You only need a **new** dev build when you change native code or add a native
module (e.g. adding another `expo-*` package). Pure JS/TS changes (screens,
engine logic, styles) reload instantly.

### Feature-by-feature checklist on the phone

| Feature | How to reach it | What to verify |
|---|---|---|
| **Live Scan** (primary) | Home → **Start Live Scan** | Camera opens immediately; live guidance ("Hold steady", "Move closer", "Lighting is too dark"); center reticle; auto-capture as you present angles; "Evidence collected" meter climbs. |
| **Auto Scan Lock** | During a Live Scan | "Evidence quality" + "AI confidence" readouts update; once confidence ≥ threshold the scan **auto-locks** with "High confidence achieved." / "Analysis complete." — no button press. Try **Keep scanning** and **View results**. |
| **Manual continue / Analyze now** | During a Live Scan | "Analyze now" appears after the front angle; tapping it runs the cloud ensemble immediately. |
| **Upload mode** (secondary) | Home → **Upload Images** | Pick 1–7 gallery photos; they run the same pipeline and land on the results screen. |
| **Manual Capture** (fallback) | Live Scan → "Manual capture" link | The original guided flow still works unchanged. |
| **Results / honest AI** | End of any scan | Best match + confidence band, or the "cannot identify with sufficient confidence" path with suggestions. |
| **Auth** | App launch | Sign-in/sign-up against the live Supabase project. |

> Camera, gallery, and location all require **physical-device** testing — the
> live camera loop, auto-capture timing, and thermals cannot be exercised in an
> emulator/simulator.

### Tuning the Auto Scan Lock threshold from the backend
The lock threshold is backend-owned. To change it without an app rebuild, set
the Edge Function secret and re-deploy:

```bash
supabase secrets set SCAN_AUTOLOCK_THRESHOLD=0.90
supabase functions deploy orchestrate-scan
```

The app reads the value returned by `orchestrate-scan` (`autoLockThreshold`) and
falls back to `0.95` if it's absent.

---

## 5. OTA (Over-the-Air) updates — push JS changes without rebuilding

Because `expo-updates` is configured against the project's update URL, you can
ship pure-JS changes to an already-installed **preview** build (or a production
build later) instantly:

```bash
cd mobile
eas update --branch development --message "tweak live-scan guidance copy"
# or for the preview channel:
eas update --branch preview --message "auto-lock threshold copy"
```

- The update `--branch` maps to the build `channel` (`development`, `preview`,
  `production`).
- Only works for changes that **don't** touch native code and that keep the same
  `runtimeVersion` (`0.1.0`). Bump the app `version` when you change native code
  so old binaries don't pull incompatible JS.
- Dev-client builds normally load from Metro; OTA is most useful for the
  **preview** build shared with testers.

---

## 6. Build a **Preview** build for internal testers

The preview profile is a standalone, release-mode app (JS embedded, no Metro
needed) for sharing with testers — still **not** a store/production build.

```bash
cd mobile
eas build --profile preview --platform android    # internal APK
eas build --profile preview --platform ios        # ad-hoc / TestFlight-ready
```

Android: share the APK link/QR; testers install directly.

---

## 7. iOS TestFlight preparation (configured, not published)

`eas.json` already has a `submit.preview.ios` block. Before you can push a
preview/production iOS build to TestFlight, fill in the two placeholders:

```jsonc
// mobile/eas.json → submit.preview.ios
"appleId": "your-apple-id@example.com",
"ascAppId": "1234567890"   // App Store Connect app's Apple ID
```

Then:

```bash
cd mobile
eas build   --profile preview --platform ios      # produces an .ipa
eas submit  --profile preview --platform ios      # uploads to TestFlight
```

You'll need an Apple Developer Program membership and an app record created in
App Store Connect. EAS can manage the signing credentials interactively the
first time. **Do not run the `production` submit profile yet.**

---

## 8. Verification performed

| Gate | Result |
|---|---|
| `expo config --type public` resolves projectId + `u.expo.dev` update URL + `runtimeVersion` | ✅ |
| `expo export --platform android` (full Hermes bundle) | ✅ 4.2 MB bundle produced |
| `tsc --noEmit` | ✅ |
| `eslint .` | ✅ |
| `jest` | ✅ 37/37 |
| `check-no-billing-deps` | ✅ payment separation intact |
| `expo-doctor` | 15/17 (2 pre-existing warnings, see below) |

### Dependency fix required to make release bundling succeed
A pre-existing, corrupted dependency resolution nested an incompatible
`react-native@0.86.0` under `@react-native/virtualized-lists`, which broke
release-variant JS bundling (`expo export` / preview / production builds). A
`react-native` **override pin to `0.74.5`** plus `npm dedupe` collapsed it back
to the single correct version. The `development` dev-client path was not
affected (it serves JS from Metro and doesn't embed the bundle), but preview and
production bundling now work as well.

### Remaining `expo-doctor` notes (pre-existing, not blocking)
1. **"Native folders present, some app.json fields won't sync."** Expected for
   this committed-`android/` workflow — it's exactly why the OTA meta-data was
   written into the native manifest by hand. iOS is unaffected (prebuilt by EAS).
2. **`@sentry/react-native@5.36.0` vs expected `~5.24.3`.** Pre-existing version
   choice from the crash-reporting setup; left as-is (out of scope for this
   task). Revisit only if Sentry misbehaves on a real build.

---

## 9. Guardrails / do-not-do

- **No production build or store submission** was created or triggered.
- The `production` build + submit profiles exist but must be run deliberately and
  only when releasing — not part of development testing.
- Keep payments on the website only; the no-billing-deps guard still enforces
  this and passes.
- The `submit.*.ios` placeholders must be replaced with real Apple IDs before any
  iOS upload; don't commit real Apple credentials into `eas.json` if the repo is
  shared — prefer EAS-managed credentials.

---

## 10. Quick reference

```bash
# First time
npm i -g eas-cli && cd mobile && npm install && eas login

# Android dev build (once), then live-reload loop
eas build --profile development --platform android
npx expo start --dev-client

# iOS dev build (register device once)
eas device:create
eas build --profile development --platform ios

# Ship a JS-only change to installed preview testers
eas update --branch preview --message "…"

# Internal preview builds
eas build --profile preview --platform android
eas build --profile preview --platform ios
```

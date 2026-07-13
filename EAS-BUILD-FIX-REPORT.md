# EAS Build Fix Report

## Original error

The GitHub-connected EAS build surfaced its failure at the **Install dependencies**
step, but the raw build logs showed dependency installation actually *succeeded*
(`added 1611 packages`, preinstall billing-guard passed). The first real fatal
error came one phase later, in `READ_APP_CONFIG`:

```
[50][READ_APP_CONFIG] The "extra.eas.projectId" field is missing from your app config.
[EAS_BUILD_INTERNAL] EAS project not configured. Must configure EAS project by
running 'eas init' before this command can be run in non-interactive mode.
```

## Root cause

GitHub-triggered EAS builds build from the **committed** source, not the local
working tree. The committed `mobile/app.json` at commit `b5e2a79` was missing the
EAS project binding:

- committed `extra` was only `{ "router": { "origin": false } }`
- no `extra.eas.projectId`
- `slug` was `gemscan-ai` and `owner` was unset

Without `extra.eas.projectId`, a non-interactive build cannot resolve which EAS
project it belongs to, so it errored out immediately after reading the app config.
The `Install dependencies` label in the dashboard was the last *green* step shown,
which made it look like the install itself failed — it did not.

## Files changed

- `mobile/app.json` — **the fix**: added
  `extra.eas.projectId = d24307ed-5428-4bbc-97ba-efd4a426856b`, plus `owner`
  (`gemestones-team`), corrected `slug` (`gemestone`), `runtimeVersion` (`0.1.0`),
  `updates.url`, `splash.image`, and `android.adaptiveIcon`.

(The same commit also bundles this session's already-completed mobile work —
branded logo/icon/splash assets, in-app `LoadingScreen`, graceful
email-confirmation handling in registration, and the live/upload scan screens.
None of these affect the build fix; the projectId addition is what unblocks it.)

## Commit hash

`a3c777d7a47f8a9827399642ec29c400157b624a` (pushed to `main`,
`b5e2a79..a3c777d`).

## New build ID

`d2779076-3ba6-471e-a9f4-75667dd16360`
Logs: https://expo.dev/accounts/gemestones-team/projects/gemestone/builds/d2779076-3ba6-471e-a9f4-75667dd16360

## Verification

- GitHub source used — Started by **GitHub App · @barbaarintasan-ship-it**, built
  from commit `a3c777d`.
- `package.json` detected — yes (READ_PACKAGE_JSON passed).
- Dependencies installed successfully — yes.
- Build completed — **Status: finished**.
- APK artifact generated — yes.

## Installable APK

**https://expo.dev/artifacts/eas/iTuomD5ENToC1lRRNRDHlKV_yaJtGYD8cwJvPlRGoXU.apk**

Profile: `preview` (internal distribution) · Platform: Android · Version 0.1.0
(versionCode 1). Download this URL on your Android phone and install it to test.

## Final status

**SUCCESS** — root cause fixed, committed, pushed; the new GitHub-sourced Android
Preview build completed and produced an installable APK.

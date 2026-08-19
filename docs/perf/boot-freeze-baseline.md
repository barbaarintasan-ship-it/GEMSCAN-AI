# Boot-freeze baseline (perf/boot-freeze Phase 1)

Branch: `perf/boot-freeze` (from `chore/expo-sdk-53`, i.e. Expo SDK 53 / RN 0.79,
16 KB-aligned). Captured on device **Samsung SM-A165F** via `adb logcat -s
ReactNativeJS`, reading the app's own `jsStall` diagnostic (`STALL_MS = 250`;
"UNRESPONSIVE" is its severe tier). This file is the "before" that Phase 5's
on-device re-measure is compared against. No app code has been changed yet.

## Symptom
The JS/UI thread is unresponsive for **~1.8–8.4 s** shortly after launch / when
the map opens. It is a **freeze, not a crash** (`FATAL count: 0`; the app renders
the map afterwards). The native activity itself starts fast (`am start`
TotalTime ≈ 374 ms) — the block is entirely in the JS boot cascade.

## Measured — the cascade (real user state: logged in, 31 queued outbox records)
Phase stack at the stall (nested = concurrently-open `markPhase` frames):
```
appUpdate.check › subscription.fetch › publicStats.fetch
  › expeditionSync.drain › expeditionSync.drain.pushOutbox[N]
    › pushOutbox.getSession                 (~1.3 s)
    › explore.retarget › targeting.rank[37] (~1.5 s)
      › pack.handover › pack.require        (~0.3 s, the 20 MB pack)
  › map.buildScene                          (~0.37 s)
```

| Phase | Measured worst | Note |
|---|---|---|
| `expeditionSync.drain` (whole) | **UNRESPONSIVE up to 6800–8411 ms** | dominant; draining N queued records |
| `expeditionSync.drain.pushOutbox` | up to 8315 ms | the outbox push, runs "now" on mount |
| `pushOutbox.getSession` | 1178–1339 ms | supabase getSession; has a timeout but still blocks |
| `targeting.rank[37]` | 1461–1782 ms | scoring 37 cells (deferred, but on the same tick) |
| `pack.require` (20 MB GIS pack) | 302–393 ms | `maplayers.json` 13.9 MB + `terrain.json` 5.7 MB |
| `map.buildScene` | 363–381 ms | scene assembled from the pack |

## Controlled experiment (proves the map tile layers are NOT the cause)
Toggling **Satellite + Roads & tracks + Place names OFF**, then cold-booting:
| State | JS unresponsive |
|---|---|
| 3 tile layers ON | ~8.4 s |
| 3 tile layers **OFF** | **~4.3 s — still frozen** |
The map rendered fine without satellite (hillshade base). So the WebView tile
layers are ruled out; the freeze is the outbox-sync + scoring + pack cascade.

## Additional finding (SDK 53 fresh install, empty outbox, no session)
```
UNRESPONSIVE 5534ms IN: subscription.fetch
```
Even with an empty outbox, boot still froze ~5.5 s under `subscription.fetch` —
so the boot-network calls (`appUpdate.check`, `subscription.fetch`,
`publicStats.fetch`) are themselves part of the cascade, not only `pushOutbox`.

## Bonus (device validation)
The **SDK 53 / RN 0.79 build boots on-device with `FATAL count: 0`** — the h3-js
`TextDecoder`, SoLoader merged-mapping, and `promise` hoist fixes all work at
runtime (first on-device confirmation of the migration).

## Clean SDK 53 baseline (verified build, fresh install, empty outbox, HOME screen)
Installed APK md5 == the built `app-release.apk` (`b110db2d…`); contains
`lib/arm64-v8a/libreactnative.so` (RN 0.79 merged lib) — confirmed the SDK 53
build. Cold boot to the **home screen** (logged in, Professional):
```
UNRESPONSIVE 2616ms IN: subscription.fetch
  … › explore.retarget › targeting.rank[37]  (1741 ms)
  … › pack.handover › pack.require            (566 ms)
map.buildScene                                (374 ms)
```
- **~2.6 s** JS-unresponsive **even on the HOME screen** — because
  `ExplorationProvider` + `MapWorkspaceProvider` mount at the ROOT provider tree,
  so `pack.require` + `targeting.rank` + `map.buildScene` run at every boot,
  regardless of which screen is shown. (No `pushOutbox` here: empty outbox. With
  queued records it climbs to the ~4–8 s above.)
- `FATAL 0`, app renders correctly → SDK 53 runtime confirmed on-device.

## Data volume (static measurement)
`assets/geo-pack/`: `maplayers.json` **13.9 MB**, `terrain.json` **5.7 MB**,
`geology.json` 0.48 MB, others small → **~20 MB**, loaded as ONE all-or-nothing
unit (`tryRequireAll` requires every file; no per-layer loading).

## Success criteria for the fix (Phase 2–5)
- No `jsStall` **UNRESPONSIVE** during boot; boot stalls under the `STALL_MS`
  (250 ms) threshold.
- Ranking output byte-identical (leakage baseline + `prospectivityBaseline` pass).
- No outbox record lost; offline-first behavior unchanged.
- Re-measured on-device with the same `adb logcat -s ReactNativeJS` method; the
  pushOutbox part re-validated with queued records present.

## Caveat
The dominant `pushOutbox` freeze only manifests when the outbox holds queued
records. The device was later reinstalled (state cleared), so Phase 5's on-device
re-validation of the pushOutbox path must first seed queued records (or rely on
the jest regression tests for that path).

# GemScan AI — Live Scan Implementation Report

Transforms the mobile scan experience from a "take a photo" flow into a
real-time, Google-Lens-style **live AI scanner**, while preserving the existing
backend, AI orchestration, authentication, storage, and result pipeline.

**Core principle honored:** the existing AI Scan Pipeline was NOT replaced.
Live Scan and Upload are new *front ends* over the same on-device processing and
the same single `orchestrate-scan` cloud call.

---

## 1. What was reviewed first (no code changed until this was done)

| Area | File | Verdict |
|---|---|---|
| Backend contract | `mobile/lib/scanUpload.ts` | **Reuse as-is** — `createScan` / `uploadScanImage` / `runOrchestration` / `submitScanFeedback` |
| On-device Stage 1/3 | `mobile/components/ImageProcessorGL.tsx` | **Reuse as-is** — `assessQuality()` per frame, `enhance()` on captures |
| On-device Stage 2 | `mobile/lib/onDeviceDetection.ts` | **Reuse as-is** (no-op-safe until models are bundled) |
| Segmentation | `mobile/lib/backgroundSegmentation.ts` | **Reuse as-is** (no-op-safe) |
| Result + honest-AI | `mobile/app/(app)/scan/results.tsx` | **Reuse as-is** for all modes |
| Cloud ensemble | `supabase/functions/orchestrate-scan/**` | **Untouched** |

---

## 2. Components: reused / modified / new

**Reused unchanged:** `scanUpload.ts`, `ImageProcessorGL.tsx`, `onDeviceDetection.ts`,
`backgroundSegmentation.ts`, `location.ts`, `monitoring.ts`, `results.tsx`, and the
entire `orchestrate-scan` Edge Function.

**Modified (additive, backward-compatible):**
- `mobile/app/(app)/index.tsx` — primary CTA now **Start Live Scan**; added **Upload Images**.
- `mobile/app/(app)/scan/_layout.tsx` — registered `live` + `upload` routes; the
  original guided flow stays reachable as **Manual Capture**.

**New:**
- `mobile/lib/liveScanEngine.ts` — pure, framework-free real-time state machine.
- `mobile/lib/__tests__/liveScanEngine.test.ts` — 13 unit tests.
- `mobile/app/(app)/scan/live.tsx` — the live scanner screen (camera loop + HUD).
- `mobile/app/(app)/scan/upload.tsx` — gallery upload mode.

No existing screen's behavior was removed. `capture.tsx` is intact.

---

## 3. How the live experience works

Tap **Start Live Scan** → the camera opens immediately and analyzes continuously:

```
CameraView preview
  → ~600ms low-res snapshot (takePictureAsync, skipProcessing)
  → on-device assessQuality (blur / exposure / sharpness)   [Stage 1, existing]
  → liveScanEngine.processFrame(state, quality)             [new, pure]
       → live guidance text
       → steadiness + best-frame gating
       → auto-capture decision per angle
       → evidence meter + intelligent stop
  → (only on lock-in) full-res capture → enhance + detect   [Stage 2/3, existing]
  → (only once, at the end) createScan → upload → orchestrate-scan  [existing cloud call]
  → results.tsx                                              [existing]
```

**Required scan-mode features delivered:** continuous preview, real-time quality
analysis, auto specimen framing (reticle), blur detection, lighting analysis,
motion/steadiness detection (frame-to-frame sharpness stability), best-frame
selection, progressive evidence updates, automatic multi-angle capture
(front → left → right → top → bottom → macro → optional wet), on-device
enhancement, and intelligent stopping.

**Live guidance strings:** "Move closer", "Hold steady", "Lighting is too dark",
"Too bright — reduce glare", "Collecting more evidence…", "Excellent image —
captured", "Analyzing — enough high-quality evidence collected", plus a per-angle
"Now show the …" prompt.

**Upload mode:** single or multiple gallery images, mapped in order onto the
angle sequence, run through the identical pipeline.

---

## 4. Local-AI-first / cost & battery

- Only the **cheap on-device** `assessQuality` runs per sampled frame (~1.6 fps).
- A **full-resolution capture + enhancement** happens **only** at the moment an
  angle locks in — not per frame.
- Still exactly **one cloud call per scan** (`orchestrate-scan`), identical to the
  previous flow. **Zero per-frame cloud cost / API spend.**
- Sampling cadence (`SAMPLE_INTERVAL_MS = 600`) is a single tunable knob for the
  responsiveness vs. battery trade-off.

---

## 5. Honest AI

Unchanged and preserved: the on-device evidence meter is explicitly labeled
**"Evidence collected"** (scan completeness), never an identification-confidence
claim. The real verdict — including the "We cannot identify this specimen with
sufficient confidence" path and improvement suggestions — still comes solely from
the cloud ensemble and is rendered by the existing `results.tsx`.

---

## 6. Key architectural decision — no new native deps, no prebuild

`expo-camera` v15 (already installed) has **no JS frame-processor API**; true
per-frame worklet access would require `react-native-vision-camera` + a config
plugin + an `expo prebuild` regeneration. That was **deliberately avoided** to
respect "reuse as much as possible / maintain backward compatibility / don't
break existing functionality" and the project's prior caution around prebuilds.

Instead, live analysis uses periodic low-res `takePictureAsync` snapshots fed to
the existing GL quality checker. **No dependency was added** (`expo-image-picker`
was already present for Upload mode). The no-billing-deps guard still passes.

---

## 7. Verification

| Gate | Result |
|---|---|
| `tsc --noEmit` (mobile) | ✅ pass |
| `eslint .` (mobile) | ✅ pass (0 warnings) |
| `jest` (mobile) | ✅ **21/21** (8 existing + 13 new engine tests) |
| `check-no-billing-deps` | ✅ payment separation intact |

The pure engine is fully unit-tested: guidance selection, steadiness gating
(a moving camera never auto-captures), best-frame/stable-frame gating, angle
progression, evidence bounds `[0,1]`, intelligent stop, and post-completion
idempotency.

---

## 8. Remaining risks / follow-ups

1. **On-device frame cadence is device-dependent.** Repeated `takePictureAsync`
   at ~1.6 fps is smooth on mid/high-end phones; low-end devices may want a
   larger `SAMPLE_INTERVAL_MS`. Needs on-device tuning (cannot be measured in CI).
2. **Shutter sound on rapid sampling.** `skipProcessing` is used; some Android
   OEMs may still emit a shutter tone per capture. Verify on real hardware; if
   audible, gate sampling frequency or explore a silent-capture path.
3. **Detector/classifier/segmentation still no-op** until the trained `.tflite`
   models are bundled (pre-existing condition, unchanged). Live framing uses the
   reticle + quality heuristics rather than a trained detector for now; dropping
   the detector model in will sharpen auto-framing with no screen changes.
4. **Upload angle mapping is positional** (1st image → front, etc.), since a
   gallery image has no inherent angle. This only affects per-angle metadata, not
   identification.
5. **Gallery permissions** rely on the OS photo picker; on older Android a
   runtime read-media permission prompt may be needed — verify on target minSdk.
6. **Live device QA pending.** Logic is unit-tested, but end-to-end camera-loop
   behavior (timing, thermals, real guidance feel) must be validated on physical
   Android/iOS hardware before release.

---

## 9. Status

**Complete and green on all automated gates.** The primary experience is now a
live AI scanner; Upload is available as a secondary mode; Manual Capture remains
as a backward-compatible fallback. Backend, AI orchestration, auth, storage, and
results are unchanged. Ready for on-device QA.

# Live Scanner Upgrade Report — Real-Time AI Gemstone Scanner

Scope: upgrade the existing **Live Scan** feature into a true real-time scanner
experience — continuous preview, on-device object detection gate, a professional
scanning HUD, automatic angle capture, and the existing multi-model AI ensemble.
The rest of the app was **not** redesigned, and the cloud scan pipeline
(`orchestrate-scan`, ensemble voting, `scans` / `scan_images` / `scan_candidates`
persistence) is **unchanged** — only how the live screen *gathers and gates*
frames changed.

## Requirement-by-requirement

### 1. Real camera preview
The live screen already ran a continuous `expo-camera` preview with a background
analysis loop and no shutter button. That is preserved: frames are sampled
continuously and fed to the analysis loop; the user never taps to capture.

### 2. Gemstone object detection (the real gap — now closed)
Added a pure, on-device **object-presence gate** —
[mobile/lib/gemstoneDetector.ts](mobile/lib/gemstoneDetector.ts).

- Why heuristic: [mobile/lib/onDeviceDetection.ts](mobile/lib/onDeviceDetection.ts)
  is wired for a trained TFLite/YOLO detector, but **no model artifact is
  bundled** (both entry points fail-soft to `null`). So before this change there
  was *no* real object gate. The heuristic reads the **same small RGBA frame the
  quality check already samples** — no extra capture, no network, no GPU beyond
  the single `readPixels` the loop already does.
- What it measures: centre-vs-border contrast (a held specimen differs from the
  surface behind it), edge/facet structure (local gradients), colour saturation,
  and specular sparkle. It blends these into an `objectness` score and derives a
  bounding box from where the centre deviates from the background.
- Gate behaviour: while in the `detecting` phase, the scanner requires
  `REQUIRED_DETECTION_FRAMES` (3) consecutive present frames above
  `GEM_PRESENCE_THRESHOLD` (0.42) before it starts capturing/AI. An empty or
  uniform scene stays well below threshold, so the app shows **"No gemstone
  detected. Please place a gemstone in front of the camera."** and does **not**
  start any AI work.

This is a presence/localization gate, **not** a final identity call. The
definitive "is this actually a gemstone vs a rock/metal/plastic" verdict remains
the cloud ensemble's job (requirement 8) — the gate just stops the scanner
spending cloud calls on an empty scene.

### 3. Scanning HUD
[mobile/app/(app)/scan/live.tsx](mobile/app/(app)/scan/live.tsx) now renders a
professional HUD driven by the React Native `Animated` API (native driver):

- A **sweeping scan line** that travels top ↔ bottom over the frame.
- An **animated detection frame** with pulsing corner brackets that tracks the
  detected object's bounding box (falls back to a centred reticle while still
  detecting).
- A **live confidence indicator** and a **scan progress %** meter.
- **Status narration** that walks through "Detecting object…" → "Gemstone
  detected" → "Capturing angles…" → "Analysing surface…" → "Preparing AI
  analysis…", mapped through `SCAN_STATUS_I18N_KEY` and localised (EN/SO).

### 4. Automatic angle capture
Preserved from the existing pipeline: once past the gate, the loop auto-collects
high-quality frames across views (the user just holds and rotates slowly — copy:
"Hold the gemstone steady, then rotate it slowly"). No manual multi-photo upload
is required.

### 5. AI pipeline (ensemble)
Unchanged. After enough evidence is collected, the captured frames are sent to
the existing `orchestrate-scan` ensemble (Gemini / OpenAI / Claude Vision) which
returns the identification, confidence, alternatives, physical properties and
uncertainty handling. Low confidence still asks the user to keep scanning rather
than guessing.

### 6. Upload option (secondary)
Kept as a secondary action — "Upload gemstone photos" / manual capture links
remain on the live screen.

### 7. Database
Unchanged — the same `scans` session, `scan_images` (with `detection_bbox`) and
`scan_candidates` rows are written by the existing pipeline. The heuristic box is
now used as a fallback for `detection_bbox` when the (absent) model returns none.

### 8. Non-gemstone rejection — testing
The gate + ensemble combination is what rejects non-gemstones. The on-device gate
is unit-tested directly against synthetic frames
([mobile/lib/__tests__/gemstoneDetector.test.ts](mobile/lib/__tests__/gemstoneDetector.test.ts)):
a uniform/empty scene and a low-amplitude background gradient are **rejected**
(`present: false`, below threshold, no box), while a distinct, structured,
saturated centre object is **detected** with a plausible bounding box. The final
"rock / metal / plastic vs gemstone" rejection remains the cloud ensemble's
low/insufficient-confidence path.

## Verification

- **Typecheck:** `tsc --noEmit` — passed (0 errors).
- **Tests:** `jest` — **45/45 passed**, including the new 8-case
  `gemstoneDetector` suite and the unchanged `liveScanEngine` / `autoScanLock` /
  `ImageProcessorGL` suites (confirming the cloud pipeline is untouched).

## Files changed

New:
- `mobile/lib/gemstoneDetector.ts` — pure object-presence gate + scan-status model.
- `mobile/lib/__tests__/gemstoneDetector.test.ts` — 8 tests (rejection + detection).

Modified:
- `mobile/components/ImageProcessorGL.tsx` — added `analyzeFrame` returning
  `{ quality, detection }` from a single shared pixel read (`readAnalysisPixels`).
- `mobile/app/(app)/scan/live.tsx` — detection-gate phase model + professional
  HUD. Cloud pipeline calls preserved.
- `mobile/locales/en.json`, `mobile/locales/so.json` — new `scanner.*` strings.

## Build

- **Commit:** _(this commit)_
- **Android preview build:** the EAS build is a manual `workflow_dispatch`
  (`.github/workflows/eas-build.yml`) and consumes metered build minutes; trigger
  it with `gh workflow run eas-build.yml -f profile=preview -f platform=android`
  (requires the `EXPO_TOKEN` repo secret). CI (`ci.yml`) runs typecheck + the full
  jest suite on this push.

# LuulScan — Migration & Implementation Plan
## Three fixes, in the priority you set: (1) Prospectivity scoring, (2) Vision pipeline, (3) Lineament integration

### Guardrails (apply to every phase)
- **No untested version ships.** Each phase: code → unit tests → `tsc --noEmit` → full `jest` → only then build/deploy.
- **The validated geological RANKING is NOT changed.** `computeConfidence` / target `score` (LOO AUC 0.900, BLIND 0.843) stays byte-identical. All fixes add moderation or inputs *around* it, never inside the validated path.
- Every step degrades gracefully — an AI/vision/network failure never destroys mission data.

---

## PHASE 1 — Prospectivity scoring (kill the wrong 1.00)

### Root cause (confirmed in code)
- `renderReport` prints `engine.prospectivityScore` **raw** — it comes from targeting's `computeConfidence`, a pure noisy-OR with **no group cap and no completeness gate** (`shared/geo-core/confidence.ts`).
- `cappedConfidence` already gates the **confidence enum** (that is why the report says "Confidence LOW") but it does **not** touch the numeric prospectivity.
- Two field observations at one outcrop (quartz vein + fault) are two independent groups → noisy-OR saturates to ~1.00.

### Design — separate evidence STRENGTH from displayed CONFIDENCE
- Keep raw `score` for **ranking** (unchanged → validation intact).
- Add a **gated report prospectivity** used only for display.

### Code changes
1. **NEW `shared/geo-core/gie/prospectivityReport.ts`** — `reportProspectivity(scored): number`, pure/deterministic:
   - noisy-OR over collapsed groups → `base` (same raw strength).
   - **single-evidence-group cap** on role diversity (field/structural/geology/occurrence/terrain/community/association): `categories ≤ 1 → cap 0.5`; `== 2 → cap 0.75`; `≥ 3 → uncapped`. (Mirrors the accepted `scoreConclusion` cap, applied on category diversity so two field obs at one outcrop can't saturate.)
   - **completeness gate**: shrink toward the cap when high-value corroboration (occurrence OR mapped structure OR lab/geochem) is absent.
2. **`mobile/lib/geo/targeting.ts`** — `ExplorationTarget` gains `reportScore` = `reportProspectivity(scored)`; `score` (raw) unchanged; `buildTarget` computes both.
3. **`mobile/lib/exploration/packageStore.ts`** — persist `reportScore` on the package.
4. **`shared/geo-core/gie/renderReport.ts`** + **`report/[missionId].tsx`** + **`explore/index.tsx`** — display `reportScore` (fallback to raw when absent for old packages).

### DB migration
- **None.** `reportScore` rides in the existing package JSON / package row.

### Tests
- `prospectivityReport.test.ts`: quartz+fault (1 category) → ≤ 0.5; + lithology (2) → ≤ 0.75; + occurrence + structure (≥3) → ≈ raw.
- targeting test: raw `score` unchanged; `reportScore` gated.

---

## PHASE 2 — Vision analysis pipeline

### Root cause (confirmed)
- `runVision`/`vision.ts` exists (Gemini vision: texture/vein/alteration/mineral/structure) but is **not wired** into `analyze-mission` — that path only verifies photos exist, then sends a **text-only** prompt.
- Image caps (2 MB single) would reject the 5–7 MB field frames even if wired.
- The report **already** supports `origin:"photograph"` evidence, `photoId`, and a VISUAL EVIDENCE section — it is simply never populated.

### Code changes
1. **`vision.ts`** — add server-side **downscale before encode** (ImageScript WASM in Deno): decode → longest side ≤ 1024 px → JPEG q≈0.7 → base64. A 6 MB frame → ~150–300 KB, fits the caps, and works for photos **already** in R2.
2. **`analyze-mission/handler.ts` + `analyzeMission.ts`** — after the R2 verification gate, run `runVision` over the signed photo URLs → `VisualObservation[]`.
3. Convert observations → `FindingEvidence{ origin:"photograph", photoId, … }`, **merge into findings** (report VISUAL EVIDENCE renders them), and pass a compact vision summary into `buildMissionPrompt` so the narrative reflects them.
4. **Vision → prospectivity evidence**: photograph-origin evidence enters `reportProspectivity` as a new low-weight category (`visual` ≈ 0.4, like GIE `ai_visual`). The **report** score is recomputed server-side to include vision (the on-device capture score cannot see it).
5. **Storage**: vision findings live inside the persisted `analysis`/`MissionFindings` JSON — no schema change.

### DB migration
- **None** (findings JSON already persisted).

### Deploy
- Redeploy `analyze-mission`. Caps stay env-tunable (`GIE_VISION_MAX_*`).

### Tests
- `vision.test.ts`: downscale unit; an oversized image is admitted after resize.
- `analyzeMission.test.ts`: photos present → findings include `origin:"photograph"` evidence; VISUAL EVIDENCE non-empty; merge/parse.

### Honest caveats
- Needs a live `GEMINI_API_KEY` + reachable R2 images; any failure degrades to an empty visual section, never strands the mission.

---

## PHASE 3 — Lineament integration (finish)

### State
- 251 lineaments (Borama + Qardho) already in DB + pack. Nationwide 81-tile Copernicus DEM download in progress.
- Engine scoring **drafted** (targeting.ts + wording.ts): nearest lineament scored, low weight (0.4 < fault 0.6), single group, role "structural", `kind:"lineament"` reason. Untested/unbuilt — folded into this phase.

### Code / data changes
1. Nationwide extract `dem_lineaments_somalia.py` → **clip to Somalia ADM0** → merge → national GeoJSON.
2. DB: replace `copernicus_dem_derived` rows with the national set (chunked SQL via `gen_lineament_sql.py` + Supabase MCP); update `gis_layer_status`.
3. Pack: `patch_pack_lineaments.py` full-replaces lineament rows + manifest count.
4. Engine: keep the drafted lineament scoring; add i18n `field.reason.lineament` + `field.short.lineament` (EN + SO).

### DB migration
- Schema already exists (migration 0106). **Data-load only** — provenance via existing `dataset_registry` / `gis_layer_status`.

### Tests
- targeting: a lineament near a cell contributes structural evidence; nearest-only (parallel lineaments don't stack); weight < fault.
- reason rendering test for `lineament`; pack/DB parity count.

---

## FINAL VERIFICATION (all phases, before any APK)
- `npx tsc --noEmit` (mobile + shared) clean.
- `npx jest` full suite green (targeting, prospectivityReport, vision, analyzeMission, reportedGeology, wording, …).
- Rebuild pack; **forced Metro re-bundle**; build APK; install.
- Deploy `analyze-mission` (Phase 2).
- Ship only after everything is green.

## Summary of DB migrations
- Phase 1: none. Phase 2: none. Phase 3: none (data-load into existing 0106 schema).
- The only "migrations" are **data loads** (nationwide lineaments) and **code**, not schema DDL.

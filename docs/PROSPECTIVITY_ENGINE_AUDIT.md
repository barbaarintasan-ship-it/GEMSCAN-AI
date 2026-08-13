# KILL-CRITIC AUDIT — Universal Mineral Prospectivity Engine

**Date:** 10 August 2026 · **Basis:** the code as it stands on `feat/smart-capture`, plus the
contents of the pack actually shipped in the APK. Every claim below cites a file or a
measured count. Where I could not verify something, it says so.

---

## 0. The headline

Your status table has two entries that are wrong, and they are wrong in the direction that
matters most:

| Your table says | The code says |
|---|---|
| Multi-layer spatial scoring — 🔴 MAQAN | **Exists and is production-grade.** `mobile/lib/geo/targeting.ts` scores an H3 k-ring over faults, contacts, structural intersections, occurrences with distance decay, commodity associations, community finds and the geologist's own observations, combined with tier-weighted noisy-OR. |
| Gold-specific prospectivity model — 🔴 MAQAN | **Should not be built.** The pack already carries 23 commodity profiles with `alteration_styles`, `deposit_models`, `tectonic_settings` and `exploration_indicators`. The universal engine you describe is 80% built; what is missing is the wire between the profile and the score. |

And one entry that is far worse than 🟡:

> **Automatic lineament analysis — 🟡**

The pack ships **96 map features, all of them faults**. Zero contacts, zero lineaments,
zero drainage. The consequence is not cosmetic:

- `intersectionsOf()` requires **two different kinds** within 500 m. With no contacts in the
  pack it can never fire. That is the **strongest structural term in the whole model**
  (weight 0.75 in targeting, 0.80 in the provider) and it is dead code in production.
- The drainage term (`drainageDistM < 200 m`) never fires either: every terrain cell in the
  pack has `drainageDistM: null`.

So the model is running on a fraction of the signals it was designed around, and nothing in
the app says so.

---

## 1. What is REALLY missing — five categories, not one

### 1a. PRODUCTION-READY (works, is tested, is honest about its limits)

| Component | Where | Evidence |
|---|---|---|
| Spatial primitives | `shared/geo-core/geo/spatial.ts` | haversine, bearing, point-to-polyline, bbox padding. Unit-tested. |
| Evidence model | `shared/geo-core/types.ts` | `EvidenceItem { statement, weight, tier, provenance }` — every number carries its source. |
| Confidence maths | `shared/geo-core/confidence.ts` | Noisy-OR with tier weights (community 0.5 → lab_verified 1.0), banded. |
| GIE conclusion scoring | `shared/geo-core/gie/scoring.ts` | Richer: contradiction penalty, cross-dataset-group agreement, single-source cap at 0.6. Genuinely good evidence maths. |
| Conflict resolution | `shared/geo-core/priority.ts` | Highest-priority value wins; losers retained as alternatives, never dropped. |
| Multi-layer target ranking | `mobile/lib/geo/targeting.ts` | H3 k-ring, per-cell GeoContext, ranked, offline, deterministic, with structured reasons in two languages. |
| Structural proximity | `mobile/lib/geo/terrainProviders.ts` | `featuresNear` exact point-to-polyline with bbox pre-rejection; kind weights with distance falloff. |
| Field observations as evidence | `mobile/lib/exploration/localEvidence.ts` | `TYPE_SIGNAL` sulfides 0.85 … outcrop 0.30, discounted by GPS quality (good 1.0 / degraded 0.75 / stale 0.5 / unusable 0). This is the best-designed scoring surface in the codebase. |
| Offline pack | `shared/geo-core/pack/*` | Hashed, versioned, verified, replaced wholesale. |
| Server GIE pipeline | `supabase/functions/_shared/gie/*` | gather → vision → reasoning → scoring → assemble. **Confidence computed from evidence, never taken from the AI.** |
| Expedition lifecycle | `mobile/lib/exploration/expeditionLease.ts` | Durable open/close that survives a process kill (verified on device today). |

### 1b. EXISTS IN CODE BUT INCOMPLETE

| Component | What is there | What is not |
|---|---|---|
| Terrain / DEM | 2,191 cells with elevation, slope, **aspect**, relief, morphology. Provider emits evidence at weight 0.30. | `drainageDistM` is `null` on every cell. Terrain is **not read by `prospectivityEvidence()` at all** — targeting ignores it entirely. |
| Commodity profiles | 23 profiles, fully populated (gold has 4 alteration styles, 5 deposit models, exploration indicators, and an honest `confidence_limitations` string). | Read by exactly one consumer, `geologicalKnowledge.ts`, **server-side only**. The device's targeting engine never opens them. |
| Knowledge rules | 27 rules, 12 assemblages in the pack. | `associations`, `knowledge`, `structures`, `community` are all **0 rows**. Four of twelve pack layers ship empty. |
| Lineaments | A first-class `MapFeatureKind`, rendered, weighted 0.4. | **No producer.** Nothing in the repo derives a lineament from imagery or a DEM. It is a slot waiting for data. |
| Structural provider | `structuralGeology.ts` exists server-side. | Documented as DORMANT in `0089_structural_feature.sql`; pack has 0 structures. |

### 1c. EXISTS BUT NOT CONNECTED

1. **`gie/scoring.ts` — the better of the two confidence models — is not used by prospectivity.**
   Targeting uses the simpler `confidence.ts`. The contradiction penalty and the
   cross-dataset-group cap exist and are applied only to specimen identification.
2. **GIE vision reads field photographs, but only inside `analyze-sample`** (what is this
   rock?). No photograph ever reaches the spatial model. Your Q6 workflow does not exist.
3. **Commodity profiles never reach the device's scorer** (above).
4. **Terrain never reaches the scorer** (above).

### 1d. EXISTS BUT SCIENTIFICALLY WEAK

This is the section that matters most, and it is where I would push back hardest.

1. **The score is commodity-blind.** `prospectivityEvidence()` produces the same number
   whether the geologist is looking for placer gold or REE. A drainage-hosted placer target
   and an orogenic lode target are scored identically. This single fact makes the output
   scientifically meaningless as *prospectivity*, however good the plumbing is.

2. **Distance decay is linear and radius-relative.** `1 − d/radiusM`, with `radiusM` an
   arbitrary query parameter. Mineral-system halos are not linear and are not the same size
   for every commodity or deposit model. Changing the search radius silently changes every
   score — the same ground scores differently depending on how far the app happened to look.

3. **Noisy-OR assumes independence, and the inputs are not independent.** A fault at 300 m
   and a "fault–contact intersection at 300 m" are largely the same observation counted
   twice. An occurrence and the host-rock association derived from that same occurrence are
   counted twice. Noisy-OR over correlated evidence systematically **over-scores**.

4. **Every weight is a hand-set constant.** fault 0.70, contact 0.65, intersection 0.75,
   sulfides 0.85, association capped at 0.35. Not one is fitted to anything. They are
   plausible; they are not measured.

5. **No calibration, and no validation at all.** There is no test anywhere that asks the
   obvious question: *do the 159 known occurrences score higher than random ground?* Until
   that is answered the model is untested in the only way that counts. This is the single
   most damning gap in the audit, and it costs a day to close, not a sprint.

6. **No uncertainty.** One scalar, three bands at 0.34/0.67. No interval, no data-coverage
   term. A cell with one weak signal and a cell with six agreeing signals can land in the
   same band, and the app cannot tell the geologist which is which.

7. **Absence is not modelled.** A cell with no data and a cell surveyed and found barren
   both score zero. For exploration those are opposite statements.

8. **Mapped geology contributes nothing by design** — the comment in `targeting.ts` argues
   this well (a well-mapped barren cell must not outrank a poorly-mapped prospective one).
   But it over-corrects: lithology *is* a first-order prospectivity control once you know
   which commodity you are looking for. It is only useless while the engine is
   commodity-blind. Fix the commodity gap and this decision must be revisited.

### 1e. MISSING ENTIRELY

| | Status |
|---|---|
| Commodity selection (anywhere: UI, engine, API) | Does not exist |
| Geochemistry | `geochemistry: { anomalies: [] }` in `fusion.ts` — an empty shell. No provider, no table, no data. |
| Geophysics | Identical empty shell. |
| Remote-sensing alteration | `remoteSensing: { alteration: [] }` — empty shell. **No spectral code exists anywhere in the repo.** The word "alteration" appears only as a waypoint type and a commodity-profile field. |
| Lineament extraction | No producer (above) |
| Calibration / validation harness | Does not exist |
| Assessment "section" (open → collect → analyse → AI → result → close) | Does not exist. The expedition lease is the nearest thing and is a different object. |
| Field photo → spatial evidence | Does not exist |
| AI interpretation of a **place** (as opposed to a specimen) | Does not exist |

### 1f. SHOULD NOT BE BUILT

1. **A gold-specific model.** Your instinct in Q3 is correct — see §3.
2. **On-device spectral processing.** The app receives satellite imagery as **rendered JPEG
   tiles**, not band data. Alteration indices need multispectral source (ASTER, Sentinel-2)
   and must be computed off-device into a derived pack layer. Anything else would be a
   colour-guess dressed as science.
3. **A third confidence model.** Two already exist. That is one too many.
4. **A geochemistry/geophysics provider before there is data.** The shells are honest; a
   provider with nothing behind it is worse than no provider.

---

## 2. What to reuse — do not rebuild these

| Need | Reuse | Note |
|---|---|---|
| Scoring | `shared/geo-core/confidence.ts` + `gie/scoring.ts` | Promote `gie/scoring.ts`'s contradiction + group-agreement logic into the prospectivity path rather than writing a third model. |
| Geological context | `offlineGeoContext.ts`, `providers/*` | The provider interface is the correct extension point for every new evidence layer. |
| Commodity intelligence | `PackCommodityProfile`, `PackKnowledgeRule`, `PackAssemblageRule` | **The Commodity Intelligence Profile data model already exists.** 23 populated profiles. |
| GIS layers | `mapScene.ts`, `terrainProviders.ts` | `featuresNear` / `intersectionsOf` are the spatial-relationship primitives. |
| Spatial analysis | `geo/spatial.ts`, `geo/h3.ts` | k-ring, cell centre, point-to-polyline. |
| Target generation | `TargetingEngine` | Extend with a commodity parameter — do not replace. |
| Field evidence | `localEvidence.ts`, `waypointTypes.ts` | `TYPE_SIGNAL` already encodes mineralisation indicators, including `alteration`, `gossan`, `sulfides`, `quartz-vein`. |
| DEM / slope / aspect | `PackTerrainCell` + `makeTerrainProvider` | Data is there (2,191 cells). Only the wire to scoring is missing. |
| Occurrences | 159 rows with `commodity_key`, `deposit_type`, `host_rocks` | Enough to calibrate against. |
| AI interpretation | `gie/vision.ts`, `gie/reasoning.ts` | Vision is correctly constrained to *observable* facts. Reuse verbatim; change only what it is pointed at. |
| Provenance / audit | `expeditionLease.ts`, `outbox.ts` | The open/close + durable-record pattern the assessment section needs. |

---

## 3. Gold-specific model, or universal engine?

**Universal, unambiguously — and the codebase has already decided this for you.**

`PackCommodityProfile` carries exactly the fields a commodity model needs:

```
typical_host_rocks · associated_minerals · alteration_styles
deposit_models · tectonic_settings · exploration_indicators
confidence_limitations
```

Twenty-three of them ship today: gold, copper, REE, uranium, tin, tantalum, lithium,
chromium, PGM, diamond, emerald, corundum, tourmaline …

A gold-only model would (a) duplicate this, (b) have to be rewritten for the second
commodity, and (c) discard the one asset that makes Luul Scan defensible in Somalia — the
breadth of the knowledge base.

The pipeline you propose is right. The honest statement of where it stands:

```
Commodity Profile   → EXISTS (data)      NOT WIRED (to scoring)
geological criteria → EXISTS (rules, assemblages, associations — associations table empty)
evidence weights    → EXISTS but commodity-independent
spatial scoring     → EXISTS, production-grade
prospectivity       → EXISTS but commodity-blind
```

**One stage is missing from the whole chain: the commodity model.** Everything upstream and
downstream of it is built. That is a far better position than your table suggests — and it
is also why the current output cannot be trusted as prospectivity.

---

## 4. Pipeline: what you want vs what runs today

| Stage | Today |
|---|---|
| Data available | ✅ geology 81 · occurrences 159 · faults 96 · terrain 2,191 · commodities 23 · rules 27 · assemblages 12 — **and 4 layers empty** |
| Evidence extracted | ✅ providers → `EvidenceItem[]` with statement, weight, tier, provenance |
| Evidence scored | ✅ noisy-OR + tier weights — ⚠️ assumes independence |
| **Commodity model** | ❌ **absent — the missing link** |
| Prospectivity score | ⚠️ produced, but commodity-blind and uncalibrated |
| Target | ✅ ranked, explained, bilingual, offline |

---

## 5. Field evidence into the model (your Q6)

What exists: waypoints typed by the geologist (`sulfides`, `gossan`, `alteration`,
`quartz-vein`, …), weighted by mineralisation strength, discounted by GPS quality, fused as
a provider, and **already feeding targeting**. That last part is real and working — the
feedback loop closes today.

What does not exist:

1. **Photographs are not evidence.** They go to `analyze-sample` for specimen ID. No image
   ever reaches the spatial model.
2. **No assessment section.** Nothing opens, accumulates, closes and yields one verdict.
3. **No AI interpretation of a place.** GIE interprets a *rock*. There is no equivalent that
   reads "here is the ground, the structures, the occurrences, the terrain and six field
   photographs — assess it".
4. **No geologist confirmation record.** The Enterprise Review Console reviews *samples*, not
   *assessments*.

The architectural pieces to build this all exist: the lease pattern for open/close, the
outbox for durability, GIE vision for the photographs, and the provider interface for
folding the result back in as evidence.

---

## 6. GAP ANALYSIS

### ALREADY EXISTS — do not rebuild
Spatial primitives · evidence model · noisy-OR confidence · GIE conclusion scoring ·
conflict resolution · H3 k-ring target ranking · structural proximity with decay ·
fault/contact intersection detection *(dead for want of data)* · field observations as
weighted evidence · offline pack with integrity verification · terrain data (2,191 cells) ·
23 commodity intelligence profiles · knowledge + assemblage rules · GIE vision & reasoning ·
durable expedition lifecycle

### EXISTS BUT INCOMPLETE
Terrain in the pack but not in the scorer · commodity profiles server-side only ·
`drainageDistM` null everywhere · 4 pack layers empty (associations, knowledge, structures,
community) · lineaments renderable with no producer · structural provider dormant

### EXISTS BUT SCIENTIFICALLY WEAK
Commodity-blind scoring · linear radius-relative decay · noisy-OR over correlated evidence ·
hand-set weights · **no calibration** · **no validation** · no uncertainty · absence not
modelled · lithology excluded from prospectivity

### MISSING
Commodity selection · geochemistry · geophysics · remote-sensing alteration · lineament
extraction · calibration/validation harness · assessment section · field photos as spatial
evidence · AI interpretation of a place · geologist confirmation record

### NOT NEEDED / SHOULD NOT BE BUILT
Gold-specific model · on-device spectral processing · a third confidence model ·
geochem/geophys providers before there is geochem/geophys data

---

## 7. PRIORITY

### PRIORITY 1 — lama huraan
*Nothing here is a new subsystem. Every item is a wire, a dataset, or a measurement.*

1. **Validate the model that already ships.** Do the 159 known occurrences score higher than
   random ground? Until this is answered, every number the app shows is unverified. Costs a
   day. Do it before anything else, because it also gives the baseline that makes every later
   change measurable.
2. **Commodity Intelligence Profile → scoring.** Thread a commodity through `TargetingEngine`
   and let the profile drive which evidence counts and how much. This is the missing stage,
   and the data is already on the device.
3. **Fill the empty pack layers**, starting with **contacts** — without them the strongest
   structural term in the model is unreachable — then drainage, then `associations`.
4. **Wire terrain into prospectivity**, commodity-conditioned (drainage matters enormously for
   placer, barely for orogenic lode).
5. **Fix the correlated-evidence double count.** Group related items before combining, or
   adopt `gie/scoring.ts`'s group logic in the prospectivity path.
6. **Say what is missing on screen.** The app must state which evidence layers are absent
   here. A score built from 3 of 9 layers must not look like a score built from 9.

### PRIORITY 2 — muhiim
7. Assessment section: open → collect → analyse → AI → result → close, on the lease pattern.
8. Field photographs as spatial evidence, via GIE vision.
9. AI interpretation of a place, with confidence computed from evidence (never from the AI).
10. Geologist review and confirmation record.
11. Uncertainty and data-coverage alongside the score.
12. Commodity-specific decay functions replacing the linear radius-relative one.
13. Calibration of the weights against the occurrence set.

### PRIORITY 3 — mustaqbal
14. Remote-sensing alteration as a **derived pack layer** (ASTER/Sentinel-2, processed off-device).
15. Lineament extraction from DEM/imagery, off-device, into `mapFeatures`.
16. Geochemistry, when there is geochemical data.
17. Geophysics, when there is geophysical data.
18. Learning from confirmed outcomes.

---

## 8. The one thing I would say if I could only say one

The engineering is in better shape than your table claims and the **science is in worse
shape than the engineering**. There is a well-built, well-tested, honest machine for
combining evidence — and nobody has ever checked that the number it produces points at
ground worth walking to.

Priority 1 item 1 is not a feature. It is the question of whether any of this works.

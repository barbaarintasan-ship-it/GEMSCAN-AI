# Universal Mineral Prospectivity Engine — Implementation Plan

**Date:** 10 August 2026 · **Rule:** connect what exists; rebuild nothing.
**Companion:** [PROSPECTIVITY_ENGINE_AUDIT.md](PROSPECTIVITY_ENGINE_AUDIT.md)

---

## The finding that changes the plan

`scripts/derive-geological-contacts.ts` and `scripts/validate-contacts.ts` **already exist**,
and `scripts/build-geo-pack.ts` **already maps** `geo.geological_layer.kind` →
`contact | lineament | drainage`:

```ts
if (k.includes("contact"))   return "contact";
if (k.includes("lineament")) return "lineament";
if (k.includes("drainage") || k.includes("stream") || k.includes("river")) return "drainage";
```

So the pipeline for the three missing layers is **already built end to end**. The moment
those rows exist in `geo.geological_layer`, they flow into the pack, into `featuresNear()`,
into `intersectionsOf()` and into the score — with no code change at all.

Why they are not there is documented in the script's own header, and it is not an
engineering failure:

> Somalia's Macrostrat load uses `ST_MakeEnvelope(...)`, so all 344 "polygons" are
> 0.5-degree axis-aligned **rectangles** — a grid sampling of the map, not its boundaries.
> Derivation produced 165 "contacts", every one on a 0.25° coordinate line, six of them
> separating two units of the same lithology. They were grid lines drawn by the pipeline,
> not geology. **They were deleted, not shipped.**

That was the right call. It also means:

> **The contacts blocker is DATA ACQUISITION — a real vector geological map of Somalia —
> not code.** No amount of engineering closes it. It belongs in the roadmap as a
> procurement task with an owner, not as a sprint ticket.

### CLOSED, 10 August 2026 — the acquisition happened

The map exists: **Geological Map of Somalia, Abbate, Bruni & Sagri, 1:1,500,000**,
digitized as vector by **UNESCO IHP-WINS** and published open. 1,072 polygons,
2,135,161 vertices, UTM zone 38N, national coverage, carrying the Somali stratigraphy
by name.

The check that decided it: **82.8% of its edges are shared by exactly two polygons**,
stable whether coordinates are matched at 1 cm, 10 cm or 1 m. Adjacent units share
exact vertex sequences, so a contact is lifted out of the cartographer's own topology
rather than inferred from it. `scripts/ingest-abbate-contacts.ts` extracts **1,538
contacts, 44,476 km**, discarding 88,349 edges between two polygons of the *same* unit
— the map-subdivision error that helped sink the first attempt.

**They are in the pack and they are NOT scored.** The leakage detector reads 91% of
occurrences within range of a contact against 26% of random ground (**3.51×**, limit
2.0), and stratifying by rock type shows why: inside metamorphic ground the ratio is
**1.17×**. The map is subdivided most finely where the basement is, and the basement is
where the finds are. Scoring contacts would count the geology signal a second time.
`ROLES_NOT_SCORED` holds them; the reason is asserted in `prospectivityBaseline.test.ts`
so admitting them fails the build.

Positional accuracy is **±750 m** — 0.5 mm at 1:1,500,000 — carried on every feature.
Reconnaissance scale, never survey grade.

Drainage is different and much easier: it can be derived from the DEM already used by
`scripts/build-terrain.ts`, and `geo.terrain_cell.drainage_dist_m` is explicitly waiting
for it ("NULL while no drainage lines are loaded — never a guess").

---

# PHASE 1 — ARCHITECTURE REVIEW

## 1.1 Files to reuse as they are

| Concern | File | Why it is already right |
|---|---|---|
| Spatial maths | `shared/geo-core/geo/spatial.ts` | haversine, bearing, `pointToPolylineM`, bbox — tested |
| H3 | `mobile/lib/geo/h3.ts`, `shared/geo-core/geo/h3.ts` | k-ring, cell centre |
| Evidence contract | `shared/geo-core/types.ts` | `EvidenceItem{statement,weight,tier,provenance}` |
| Combination | `shared/geo-core/confidence.ts` | noisy-OR + tier weights |
| Better combination | `shared/geo-core/gie/scoring.ts` | contradiction penalty, group agreement, single-source cap |
| Conflicts | `shared/geo-core/priority.ts` | winner + retained alternatives |
| Structural proximity | `mobile/lib/geo/terrainProviders.ts` | `featuresNear`, `intersectionsOf`, `terrainAt` |
| Field evidence | `mobile/lib/exploration/localEvidence.ts` | `TYPE_SIGNAL` + GPS-quality discount |
| Waypoint vocabulary | `mobile/lib/field/waypointTypes.ts` | already includes `alteration`, `gossan`, `sulfides`, `quartz-vein` |
| Pack contracts | `shared/geo-core/pack/*` | hashed, versioned, verified |
| Pack build | `scripts/build-geo-pack.ts` | already handles contacts/lineaments/drainage |
| Terrain build | `scripts/build-terrain.ts` | DEM → `geo.terrain_cell` |
| AI vision | `supabase/functions/_shared/gie/vision.ts` | constrained to observable facts only |
| AI reasoning | `supabase/functions/_shared/gie/reasoning.ts` | conclusions + evidence links |
| Assembly | `supabase/functions/_shared/gie/assemble.ts` | the report shape |
| Durable lifecycle | `mobile/lib/exploration/expeditionLease.ts` | the open/close pattern the section needs |
| Durable queue | `mobile/lib/sync/outbox.ts` | offline-first delivery |

## 1.2 Functions that MUST NOT be touched

These are load-bearing and correct. Changing them risks regressions in things that work.

| Do not modify | Reason |
|---|---|
| `computeConfidence()` | Every score in the app, on both sides of the network, goes through it. Add a *caller*, not a branch. |
| `scoreConclusion()` / `overallConfidence()` | GIE parity is enforced by `contractsParity.test.ts`; the server and device must agree. |
| `haversineM`, `bearingDeg`, `pointToPolylineM` | Correct, tested, used everywhere. |
| `TargetingEngine.rank()` signature and contract | Extend via **options**, never by changing what it returns. The whole exploration UI reads `ExplorationTarget`. |
| `positionQuality()` and the GPS-quality discount | This is the honesty mechanism for field evidence. |
| `vision.ts`'s prompt constraint | "Report only what is visually observable, do not identify the deposit." That constraint is why the AI cannot inflate confidence. |
| The pack manifest/hash path | Integrity verification. |
| Anything in `lib/field/*` (sensors, lease, recorder) | Milestone 1 territory, verified on device. Prospectivity must not reach into the acquisition layer. |

## 1.3 Functions to extend

| Function | Extension | Shape |
|---|---|---|
| `prospectivityEvidence()` | Take a resolved commodity model; tag each item with an **evidence role** and a **correlation group**; add terrain/drainage terms | `(ctx, radiusM, model, local?, pack?) => Scored[]` |
| `TargetingEngine.rank()` | `opts.commodity?: string` | resolves the profile, passes the model down |
| `structureWeight()` | commodity-conditioned base weight and decay length | `(kind, distanceM, model)` |
| `makeTerrainProvider()` | emit drainage/slope/morphology as **prospectivity** items when the commodity model says they matter (placer) | same provider interface |
| `commoditiesOf()` | rank by the selected commodity first | unchanged signature |
| `DevDiagnostics` rows | evidence-coverage block | additive |
| `packGateway` | already has `commodityProfiles()`; add `depositStyles()` | mirrors the server gateway |

## 1.4 Database changes

**Nothing needs to be replaced. Three additive changes and one data job.**

| # | Change | Type | Why |
|---|---|---|---|
| D1 | `geo.site_assessment` — a new table for assessing a **place** | new table | `geo.geological_assessment` is `sample_id not null references enterprise.sample` — it assesses a *specimen*. A place is a different subject. |
| D2 | Add nullable `site_assessment_id` to `geo.assessment_evidence`, `geo.assessment_conclusion`, `geo.assessment_edge`, with `check (num_nonnulls(assessment_id, site_assessment_id) = 1)` | additive alter | Reuses the whole evidence-graph machinery instead of duplicating three tables. Existing rows are untouched. |
| D3 | `geo.commodity_profile` — confirm `deposit_models` is joined to `geo.deposit_style`; add `geo.commodity_evidence_weight` (commodity × deposit_style × evidence_role → weight, decay_m) | new table | This is the Commodity Intelligence Profile → weights mapping. It is **data**, so it must be a table, not constants in TypeScript. |
| D4 | `geo.geological_layer` rows of kind `contact`, `drainage`, `lineament` | **data only** | Schema and pack pipeline already handle them. |

Already present, no change needed: `geo.terrain_cell` (with `drainage_dist_m` waiting),
`geo.raster_layer_registry` (`kind` already allows `satellite`; `status` already has
`registered|ingesting|available`), `geo.deposit_style`, `geo.mineral_occurrence`,
`geo.geo_knowledge_rule`, `geo.mineral_assemblage_rule`.

**Two new pack files** (`PACK_FILES` + manifest counts + `PackData`):
`commodityWeights.json`, and later `alteration.json`.

## 1.5 API changes

| # | Change | Type |
|---|---|---|
| A1 | `geo.commodity_evidence_weights(p_commodity text)` RPC | new, `security definer`, `grant execute to service_role` + `authenticated` |
| A2 | `geo.deposit_styles_for(p_commodity text)` RPC | new |
| A3 | `assess-site` edge function | new — mirrors `analyze-sample`: gather → vision → reasoning → score → persist |
| A4 | `site_assessment` open/close RPCs | new — mirrors the expedition RPCs granted in `0098` |
| A5 | Extend `GeoDataGateway` with A1/A2 | additive to the interface implemented by both `supabaseGateway` and `packGateway` |

No breaking change to any existing endpoint.

## 1.6 Mobile changes

| # | Change | Where |
|---|---|---|
| M1 | Commodity selection, persisted | new `lib/exploration/commodityChoice.ts` (the `roadFactor` singleton pattern) |
| M2 | Commodity model resolution offline | new `lib/geo/commodityModel.ts` — profile + weights → `CommodityModel` |
| M3 | Evidence roles + correlation groups | extend `Scored` in `targeting.ts` |
| M4 | Terrain into prospectivity | `targeting.ts` reads `pack.terrain` via `terrainAt()` |
| M5 | Evidence coverage (present vs absent) | new `lib/geo/evidenceCoverage.ts`; surfaced in the sheet |
| M6 | Assessment section state machine | new `lib/exploration/assessmentSection.ts` on the lease pattern |
| M7 | Field photo capture bound to a section | extend the existing capture flow; photos to the outbox |
| M8 | Commodity + coverage in the UI | `ExplorationSheet` / `explore/index.tsx` |
| M9 | Validation harness | `scripts/validate-prospectivity.ts` + a jest test |

---

# PHASE 2 — ROADMAP

## PRIORITY 1 — lama huraan

**P1.1 · Validation harness — before anything else**
Score the 159 known occurrences against N random on-land points in the pack bbox.
Report: median score at occurrences vs random, **AUC**, and **lift in the top decile**.
Ship it as a script *and* a jest test with a floor, so no later change can silently make
ranking worse. Until this exists, every number the app shows is unverified.
*Touches: `scripts/validate-prospectivity.ts`, `mobile/lib/__tests__/prospectivityRanking.test.ts`. No product change.*

**P1.2 · Commodity Intelligence Profile → score**
The missing stage. `geo.commodity_evidence_weight` (D3) → pack file → `CommodityModel` →
`prospectivityEvidence(ctx, radiusM, model, …)`. Evidence roles:
`structural | lithological | alteration | occurrence | terrain | drainage | geochem | remote_sensing | field | community`.
Gold-orogenic weights structural and alteration high; gold-placer weights drainage, slope and
sediment high; REE weights lithology and geochemistry high. **Same engine, different profile.**

**P1.3 · Correlated-evidence grouping**
Give every item a `group` key (`structure:fault:<id>`, `occurrence:<id>`, …). Take the max
within a group, then noisy-OR across groups. Removes the fault / fault-contact-intersection
double count and the occurrence / association double count.
*This reuses the idea already implemented in `gie/scoring.ts`; do not invent a third model.*

**P1.4 · Terrain and drainage into prospectivity, commodity-conditioned**
2,191 terrain cells are on the device and the scorer ignores them. Wire `terrainAt()` in,
gated by the commodity model. Requires P1.5 for drainage to be non-null.

**P1.5 · Drainage layer from the DEM**
Extend `scripts/build-terrain.ts` (flow accumulation → stream lines) → `geo.geological_layer`
kind `drainage` → pack (automatic) → recompute `terrain_cell.drainage_dist_m`.
Unblocks the drainage term and every placer model.

**P1.6 · Evidence coverage on screen**
The score must state which layers contributed and which are absent here. A 3-of-10-layer
score must not look like a 10-of-10 score. **Do not hide missing data.**

**P1.7 · Contacts — start procurement now**
Not a code task. Options in priority order: (a) a licensed vector geological map of Somalia
(Geological Survey / UN / SGS archives), (b) digitise the plate maps already in the repo
(`plate-1..4.pdf`), (c) OneGeology / GMIS WFS if coverage allows. Until one lands,
`intersectionsOf()` stays dead and the app should say so via P1.6.

## PRIORITY 2 — muhiim

**P2.1 · Assessment section** — `OPEN → capture → analyse → prospectivity update → review → CONFIRM/REJECT → CLOSE`, built on the lease pattern (durable, survives a process kill, never blocked by auth). D1 + D2 + A4.

**P2.2 · Place Intelligence AI (`assess-site`)** — reuse `vision.ts` verbatim for the photographs; a new reasoning prompt whose subject is the ground, not the specimen. Input: photos + GPS + GeoContext + GIS + terrain + occurrences + commodity profile + existing evidence. Output: interpretation, extracted evidence, prospectivity impact, **missing evidence**. **Confidence is computed by `scoreConclusion()`, never read from the AI.**

**P2.3 · Field photographs as spatial evidence** — vision output becomes `EvidenceItem`s at tier `ai_visual` (0.4), folded in through the provider interface like everything else.

**P2.4 · Geologist review record** — confirm/reject with an actor, persisted; extends the Enterprise Review Console from samples to assessments.

**P2.5 · Uncertainty and coverage alongside the score** — an interval, not just a band; and "absence of data" distinguished from "surveyed and barren".

**P2.6 · Commodity-specific decay functions** — replace `1 − d/radiusM` with a per-role decay length from the commodity model. Removes the bug where changing the search radius silently changes every score.

**P2.7 · Weight calibration** — fit the weights against the occurrence set using the P1.1 harness. Only meaningful once P1.1–P1.4 are in.

## PRIORITY 3 — mustaqbal

**P3.1 · Remote-sensing alteration as a derived pack layer**

```
Sentinel-2 / ASTER  →  processing server (band ratios, e.g. clay 6/7, iron oxide 4/2)
                    →  geo.raster_layer_registry (kind='satellite', status='available')
                    →  per-H3 alteration index  →  alteration.json in the pack
                    →  an ordinary evidence provider
```
No on-device spectral work: the app receives rendered JPEG tiles, not band data.

**P3.2 · Lineament extraction** — from the DEM (hillshade multi-azimuth + edge detection) and imagery, off-device, into `geo.geological_layer` kind `lineament`. The pack path already exists.

**P3.3 · Geochemistry** — architecture only until data exists: `geo.geochem_sample` → provider → evidence. **Do not ship an empty provider.**

**P3.4 · Geophysics** — same shape (`geo.raster_layer_registry` already allows `magnetic|gravity`).

**P3.5 · Learning from confirmed outcomes** — feed confirmed/rejected assessments back into calibration.

---

# PHASE 3 — DESIGN

## 3.1 Database schema

```sql
-- D3: the Commodity Intelligence Profile, as weights the engine can read.
create table if not exists geo.commodity_evidence_weight (
  id               uuid primary key default gen_random_uuid(),
  commodity_code   text not null references geo.commodity(code) on delete cascade,
  deposit_style_id uuid references geo.deposit_style(id) on delete cascade,  -- null = all styles
  evidence_role    text not null,          -- structural|lithological|alteration|occurrence|
                                           -- terrain|drainage|geochem|remote_sensing|field|community
  weight           numeric(4,3) not null check (weight >= 0 and weight <= 1),
  decay_m          numeric not null check (decay_m > 0),   -- halo scale for THIS role/commodity
  rationale        text not null,          -- why. a weight nobody can trace becomes folklore.
  source           text,                   -- the paper or model it came from
  ...
  unique (commodity_code, deposit_style_id, evidence_role)
);

-- D1: assessing a PLACE. geo.geological_assessment assesses a SPECIMEN and is untouched.
create table if not exists geo.site_assessment (
  id                 uuid primary key default gen_random_uuid(),
  device_session_id  text,                 -- the expedition it was collected on
  location           extensions.geography(Point,4326) not null,
  h3                 text not null,
  commodity_code     text references geo.commodity(code),
  status             text not null default 'open',
     -- open → collecting → analysing → awaiting_review → confirmed | rejected | closed
  engine_version     text not null,
  model              text,
  input_hash         text,
  prospectivity      numeric(5,2),         -- engine-computed, 0..100
  evidence_coverage  jsonb not null default '{}'::jsonb,  -- which roles contributed, which were absent
  report             jsonb not null default '{}'::jsonb,
  opened_by          uuid references auth.users(id),
  reviewed_by        uuid references auth.users(id),
  reviewed_at        timestamptz,
  review_note        text,
  opened_at          timestamptz not null default now(),
  closed_at          timestamptz
);

-- D2: reuse the evidence graph rather than duplicating it.
alter table geo.assessment_evidence   add column if not exists site_assessment_id uuid
  references geo.site_assessment(id) on delete cascade;
alter table geo.assessment_evidence   add constraint ck_evidence_one_parent
  check (num_nonnulls(assessment_id, site_assessment_id) = 1);
-- ...same for assessment_conclusion and assessment_edge.
```

**Why D2 rather than three new tables:** the evidence graph, its polarity, its contributions
and `scoreConclusion()` already work and are parity-tested against the device. A parallel
copy would be a second thing to keep correct.

## 3.2 API

```
POST  /assess-site
  { siteAssessmentId, lat, lng, commodity, photos[], fieldNotes, deviceSessionId }
  → 202 { assessmentId }        // EdgeRuntime.waitUntil, like analyze-sample

RPC   geo.commodity_evidence_weights(p_commodity text) → weight rows
RPC   geo.deposit_styles_for(p_commodity text)         → deposit styles
RPC   geo.open_site_assessment(...)                    → id      (security definer, explicit actor)
RPC   geo.close_site_assessment(p_id uuid, p_status text, p_note text)
```

Every RPC: `security definer`, `revoke ... from public`, `grant execute to service_role`
— the pattern migration `0098` had to add after the expedition RPCs silently failed.

`GeoDataGateway` gains two methods, implemented by **both** `supabaseGateway.ts` (RPC) and
`packGateway.ts` (pack file), so the device and server stay contract-identical.

## 3.3 Component architecture

```
lib/geo/commodityModel.ts        profile + weights → CommodityModel     (pure)
lib/geo/evidenceRoles.ts         the role taxonomy                       (pure)
lib/geo/evidenceCoverage.ts      which roles could contribute here       (pure)
lib/geo/targeting.ts             EXTENDED — takes a CommodityModel
lib/exploration/commodityChoice.ts   persisted selection (roadFactor pattern)
lib/exploration/assessmentSection.ts state machine (expeditionLease pattern)
lib/sync/outbox.ts               EXTENDED — new kinds: site_assessment, assessment_photo
components/CommodityPicker.tsx   selection
components/EvidenceCoverage.tsx  present ✓ / absent ✗
components/AssessmentSheet.tsx   the section surface
supabase/functions/assess-site/  gather → vision → reasoning → score → persist
```

Pure modules first, so every scoring decision is unit-testable without a device.

## 3.4 Migration plan

| Step | Change | Safe because |
|---|---|---|
| 1 | Validation harness | Reads only. No product change. Gives the baseline. |
| 2 | Migration D3 + seed weights for 2–3 commodities | New table. Nothing reads it yet. |
| 3 | Pack gains `commodityWeights.json` | Optional file — readers already tolerate absent files (the `land` precedent). |
| 4 | `CommodityModel` + roles + grouping, **behind a flag**, default = today's behaviour | Flag off ⇒ byte-identical output. |
| 5 | Run the harness with the flag on. **Ship only if AUC and top-decile lift improve.** | The gate. |
| 6 | Commodity picker; default "all commodities" = today's behaviour | Additive UI. |
| 7 | Drainage from the DEM → pack | Data only; the pipeline already exists. |
| 8 | Terrain/drainage into scoring, commodity-conditioned | Re-run the harness. |
| 9 | Evidence coverage UI | Additive; makes every gap above visible. |
| 10 | D1 + D2 + `assess-site` + section | New surface. Existing workflows untouched. |

**The gate at step 5 is the whole discipline of this plan:** the new engine ships only if it
measurably ranks known mineralisation above random ground better than the current one does.

---

## What I would push back on

1. **"Priority 1: fill the missing layers."** Contacts cannot be filled by engineering. It is
   a data-acquisition task and it needs an owner and a date, or it will sit at 🟡 for a year
   while the strongest structural term in the model stays dead.

2. **Commodity-aware weighting without validation is a step backwards.** More knobs and no
   measurement means a model that is harder to trust, not easier. P1.1 comes first. It is a
   day's work and it is the only thing that can tell you whether any of this helps.

3. **The AI section (P2.2) is the most attractive item here and the least urgent.** A
   beautiful interpretation built on a score nobody has validated is a confident wrong answer
   delivered faster. Sequence matters more than scope.

---

# PHASE 4 — Capture Evidence + AI Senior Geologist Assessment

## 4.1 The capture model needs ONE new field

Everything you listed per photograph already exists in `mobile/lib/field/waypointTypes.ts`:

| You asked for | Already recorded | Field |
|---|---|---|
| GPS coordinate | ✅ | `position.lat/lng` + `accuracyM` + `provisional` |
| Elevation | ✅ | `position.altitudeM` |
| Timestamp | ✅ | `capturedAt`, **and** `position.fixedAt` / `ageMs` — the age of the fix, separately |
| Compass direction | ✅ | `heading.trueHeading`, `magneticHeading`, `accuracy`, **`needsCalibration`** |
| User notes | ✅ | `notes` |
| Observation type | ✅ | `type` — already `outcrop, vein, quartz-vein, gossan, sulfides, alteration, contact, fault, float` |
| **Commodity target** | ❌ | **the one addition: `commodityCode`** |

Two things the existing model does better than the request, and they must be preserved:

- **`positionQuality()`** grades every fix `good / degraded / stale / none` and discounts the
  evidence weight accordingly. A photograph taken on a 90-second-old fix is still evidence —
  it is just weaker, and it is labelled.
- **`needsCalibration`** on the heading. A compass bearing can be reported with confidence and
  be thirty degrees wrong. The AI must be told this, or it will read a structural orientation
  that was never really measured.

Missing from your list, and it should be there: **old workings** is not a `WaypointType`.
Somebody already dug here and had a reason — that is among the strongest exploration
indicators there is. Add `workings` to `WaypointType` and to `TYPE_SIGNAL` (suggest 0.75:
high, but below `sulfides`, because the target commodity of a historic dig is often unknown).

## 4.2 Lifecycle — and why there are TWO closes

Your diagram has `SECTION CLOSE` and `CLOSE ASSESSMENT` as separate events. That is correct,
and it is the most important structural decision in this workflow:

```
  -- FIELD, offline, may last a week --------------------------------
  OPEN SECTION
      |
  FIELD CAPTURE EVIDENCE      photos, waypoints, notes - all durable, all local
      |
  COLLECT DATA                pack evidence gathered at the point, offline
      |
  SECTION CLOSE               <- "I am done collecting here"
      |                          NO CONNECTION REQUIRED. Ends acquisition, nothing else.
  -- awaiting_analysis -- may sit here for days ---------------------
      |                          the package is queued, whole, on the device
  SEND ASSESSMENT PACKAGE     <- the first step that needs a signal
      |
  AI GEOLOGICAL REVIEW
      |
  PROSPECTIVITY INTERPRETATION
      |
  GEOSCIENTIFIC REPORT
      |
  HUMAN GEOLOGIST CONFIRMATION
      |
  FINAL STATUS   CONFIRMED | REJECTED | NEED_MORE_DATA
      |
  CLOSE ASSESSMENT
```

The Field Reliability Contract, applied to this workflow:

1. Opening, capturing and closing a **section** must work with no signal, ever. The section is
   field acquisition, and acquisition never depends on the network.
2. `awaiting_analysis` is a first-class, durable state. A section closed in Karkaar on Monday
   and analysed in Bosaso on Thursday is the normal case, not an error path.
3. Nothing here may block on authentication. The lease already establishes this rule.
4. `NEED_MORE_DATA` returns the assessment to `awaiting_more_evidence` — it **reopens capture**
   rather than closing the record. That status is the whole reason the loop is a loop.

## 4.3 The Assessment Package must declare its own gaps

```
AssessmentPackage {
  sectionId, commodityCode, openedAt, closedAt, collectedBy
  location   { lat, lng, altitudeM, accuracyM, h3 }
  photos[]   { uri, capturedAt, position(+quality), heading(+needsCalibration), notes, type }
  waypoints[]
  context    { geology, occurrences, faults, terrain, knowledgeRules, assemblages }
  commodityProfile { hostRocks, associatedMinerals, alterationStyles,
                     depositModels, tectonicSettings, explorationIndicators,
                     confidenceLimitations }
  priorEvidence[]
  coverage   { role -> present | absent | empty_layer }     <- REQUIRED, not optional
  packVersion, engineVersion, appBuild
}
```

`coverage` is not decoration. Today the package would carry:

| Role | State |
|---|---|
| geology, occurrence, structural (faults), terrain, field, knowledge | present |
| **contacts, drainage** | **not_scored** — 1,538 Abbate contacts and 16,870 derived reaches are LOADED and deliberately withheld from scoring, each with its reason stated |
| **lineaments** | **empty_layer** — the layer exists and has no rows |
| **geochemistry, geophysics, remote sensing** | **absent** — no data source at all |

**The AI must be told this explicitly.** Otherwise it reads silence as negative evidence and
writes "no alteration indicators" when the truthful statement is "alteration was never looked
for here". That distinction is the difference between a geological assistant and a confident
liar.

## 4.4 The AI's role, and its hard limits

Role: **Senior Exploration Geologist Assistant.** It may:

- interpret the geology from the photographs and the spatial context,
- perform mineral-system analysis against the commodity profile,
- compare against the deposit models in `geo.deposit_style`,
- evaluate the evidence and say which items support and which contradict a conclusion,
- **name what is missing** and what would resolve it,
- state the prospectivity impact of the field evidence.

It may **not**:

| Prohibited | Enforced by |
|---|---|
| Report its own confidence | Confidence is computed by `scoreConclusion()` from the evidence graph. Any number the model emits is discarded. This is already how `analyze-sample` works — reuse it, do not relax it. |
| Identify a deposit from photographs alone | `vision.ts` is already constrained to *observable* facts (texture, colour, minerals, veining, alteration, weathering, structure). Reuse it verbatim. |
| Be the final authority | `status` cannot reach `confirmed` while `reviewed_by is null`. Enforce in the database, not in the UI. |
| Treat absent data as negative evidence | `coverage` goes into the prompt, and "missing evidence" is a required output field. |
| Invent a locality or a grade | Invariant 4. Unknown stays Unknown. |

Two AI stages, both reusing code that exists:

1. **Vision** — `gie/vision.ts`, unchanged. Photographs become `VisualObservation[]` at tier
   `ai_visual`, base weight 0.4.
2. **Site reasoning** — a new prompt whose subject is the ground rather than a specimen,
   emitting conclusions with supporting and contradicting evidence links, scored by
   `scoreConclusion()` exactly as `analyze-sample` already does.

## 4.5 The report

Your example maps onto tables that already exist:

| Report line | Source |
|---|---|
| Assessment ID `LS-2026-001` | `geo.site_assessment.id` plus a human-readable reference |
| Target commodity | `site_assessment.commodity_code` |
| Deposit model | best-matching `geo.deposit_style`, with the match reasoning |
| Prospectivity: High | `site_assessment.prospectivity` — **engine-computed** |
| Confidence: Medium | `overallConfidence()` over the conclusions — never the AI's |
| Supporting evidence ✓ | `assessment_edge.polarity = 'supporting'` |
| Missing ✗ | `site_assessment.evidence_coverage` |
| Recommendation | AI, clearly labelled as advice |
| Geologist review: Pending | `reviewed_by is null` |

Add one line your example omits, and it matters more than any of the others:

```
Evidence basis:  6 of 10 layers - lineaments are EMPTY in this pack
                 contacts and drainage are PRESENT but not scored, and why
                 geochemistry, geophysics and remote sensing have NO SOURCE
```

A "High" built on six layers must not look like a "High" built on ten.

## 4.6 The real engineering risk is the photographs, not the AI

- Ten photographs per section at ~1.2 MB (`UPLOAD_MAX_EDGE_PX 2048`, quality 0.85) is ~12 MB
  per section. Twenty sections on a week-long traverse is ~240 MB — on a phone that is also
  holding the pack and the tile cache.
- `persist()` currently swallows a full disk silently. That was recorded as the **only real
  byte-loss path** in the reliability work and deferred to M3. **This workflow makes it
  reachable in normal use**, so M3 stops being optional.
- A 12 MB upload over a weak link must be resumable **per photograph**, not per section: a
  section that fails at photo 9 of 10 must not resend the first eight.

Required before the section ships:

1. Storage as a managed resource — measure free space, refuse gracefully, say so on screen.
2. Per-photo outbox entries with their own idempotency keys. The outbox already supports this
   shape; it needs the new kinds.
3. A per-section storage and upload figure, in the same panel as `Field records`.

## 4.7 Where this lands in the roadmap

- **P2.1** Section lifecycle (open → capture → close → `awaiting_analysis`), offline-first and
  durable. Depends on **M3 storage** (§4.6).
- **P2.2** `assess-site`: package → vision → site reasoning → `scoreConclusion()` → report.
- **P2.3** Field photographs as spatial evidence, folded in through the provider interface.
- **P2.4** Human confirmation, with `confirmed` unreachable without a reviewer, enforced in SQL.
- **P1.6** `coverage` — needed by §4.3, and already Priority 1 for the score itself.

The sequencing still holds: **the section is worth building only once the score it reports has
been validated (P1.1).** A beautifully structured assessment of an unvalidated number is a
confident wrong answer, delivered with better typography.

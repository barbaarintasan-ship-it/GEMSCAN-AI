# Luul Scan — Exploration Platform Architecture v2

**Status:** proposal for review. No implementation code written.
**Supersedes:** `EXPLORATION_PLATFORM_ARCHITECTURE_v1.md` (kept for its database
survey, which is unchanged and still correct).

**What changed from v1:** three knowledge layers become four — the
**Geological Site** is introduced between observation and discovery — and the
map stops being a screen and becomes the application's workspace. AI
interpretation moves from *area* scope (v1) to *site* scope, which is the right
granularity: a geologist interprets *a vein*, not *400 hectares*.

**Approved.** Sections 0.1 and 0.2 are permanent principles: they constrain
every later decision and are not open for redesign. The rest of the document is
the architecture that implements them.

---

## 0. Founding principles (permanent)

### 0.1 The Geological Knowledge Lifecycle

Geological knowledge in Luul Scan evolves through fixed stages. This is the
platform's spine.

```
Observation          what a person saw, where they stood
      ↓
Evidence             that observation, weighted and sourced
      ↓
AI Interpretation    evidence fused into reasoning
      ↓
Prospect Candidate   the strongest statement AI may produce
      ↓
Discovery            a human stands behind it, published
      ↓
Verification         an independent qualified reviewer agrees
      ↓
Verified Prospect
      ↓
Confirmed Deposit    external evidence only — laboratory, drilling
```

Three rules, enforced in the schema and the RPC layer (§5.2, §10):

1. **Every stage preserves provenance.** A record at any stage links back to
   every record it came from — expedition, site, observation, sample, photo,
   assessment, dataset, engine version, author, time. Nothing exists without it.
2. **Nothing skips a stage.** There is no path from an observation to a
   discovery, or from an interpretation to a deposit. Each transition has its
   own guard and its own evidence precondition.
3. **AI may never create a Deposit.** The engine's ceiling is Prospect
   Candidate. Promotion beyond it requires a human, and promotion to Confirmed
   Deposit requires accredited external evidence. This is enforced by the
   database, not by a prompt.

The lifecycle is *forward-only in claim strength but not in time*: new evidence
may weaken a stage as easily as strengthen it, and a demotion is recorded with
the same provenance as a promotion.

### 0.2 Map-first workflow

**The map is the operating system of Luul Scan.**

- Every workflow **begins and ends on the live map**. Capture, analysis, site
  detail, area editing, discovery review — each is a surface over a map that
  never stops running.
- The user must never feel they are navigating between disconnected screens. No
  navigation may unmount the map, the session, or the GPS watch (§7).
- **Expeditions are managed automatically.** The user opens the map and starts
  exploring; the software opens, attributes and closes the expedition. The
  geologist thinks about geology, never about database objects.
- **Nothing collected in the field is ever discarded.** Every observation
  remains available for reinterpretation as later evidence arrives. Records are
  immutable and additive; interpretations are versioned, never overwritten.

---

## 1. Review of the existing architecture

*(Deliverable 1. The full survey is in v1 §0; this is what matters for v2.)*

Three systems exist and work:

**The offline geological engine (mobile).** `PackStore` → `OfflineGeoContextService`
→ `TargetingEngine` → `ExplorationOrchestrator`, with `FieldSessionController`
owning GPS/heading, `TrackRecorder` owning the traverse, `WaypointStore` owning
observations, and `localEvidence` already fusing the geologist's own waypoints
back into targeting as weighted evidence. This is mature and stays.

**The reasoning engine (server).** `analyze-sample` → GeoContext providers →
`shared/geo-core/gie` (EvidenceNode → scored conclusions → overall confidence) →
persisted as a real evidence graph in `geo.geological_assessment` +
`assessment_evidence` + `assessment_conclusion` + `assessment_edge`. Bilingual,
tier-weighted, idempotent by `input_hash`. This is the single most valuable
asset in the codebase and it is **already the shape Layer 4 needs** — it is
merely attached to one photograph set at a time.

**The enterprise data model (database).** 94 migrations describing missions,
areas, tracks, observations, chain of custody, lab results, verification,
RBAC, organisations and projects — of which the mobile app uses exactly one
table (`enterprise.sample`).

The vocabulary is also already there, and v2 reuses it rather than inventing
parallel terms:

| Existing enum | Values | Used in v2 for |
|---|---|---|
| `structure_type` | vein, fault, fold, foliation, joint, shear, contact, bedding | Geological Site types |
| `alteration_type` | silicification, sericitic, argillic, propylitic, potassic, oxidation, carbonate | alteration sites |
| `verification_state` | unverified → community_confirmed → expert_verified → **lab_verified** | who has confirmed a discovery |
| `evidence_type` | visible_gold, historical_mining, previous_exploration, **lab_assay**, **drill_result**, gov_academic_reference, community_report | evidence classes |
| `finding_type` | sample_collected, **no_mineralization**, inaccessible, other | negative results are first-class |
| `sample_method` | grab, rock_chip, channel, soil, stream_sediment, float | how a sample was taken |
| `audit_action` | insert, update, delete, verify, **promote**, login, export | the promotion audit trail |

`no_mineralization` deserves a note: the schema already treats *"I looked and
there was nothing"* as a recordable finding. That is a mark of a serious
exploration model, and v2 keeps it — negative evidence is what stops the same
ground being walked twice.

---

## 2. Enterprise models reusable unchanged

*(Deliverable 2.)*

| Model | Reused as | Change needed |
|---|---|---|
| `enterprise.organization`, `organization_member`, `project` | ownership + sharing | none |
| `enterprise.exploration_mission` (+ `mission_area`, `mission_contributor`, `mission_assignment`, `mission_progress`) | **planning** layer above expeditions | none |
| `enterprise.exploration_area` | Exploration Area (boundary MultiPolygon, confidence, verification, project scope) | none |
| `enterprise.area_membership` | who may contribute to an area | none |
| `enterprise.survey_track` | the walked traverse (LineString, h3 cells) | none |
| `enterprise.sample` + `sample_media`, `sample_location`, `sample_device_context`, `sample_review`, `sample_revision`, `sample_discussion`, `sample_chain_event`, `custody_signature` | samples and their custody | + parent FKs (§4) |
| `enterprise.rock_observation`, `mineral_observation`, `alteration_observation` | per-sample observations | none |
| `enterprise.lab_result` | the only thing that may create a Confirmed Deposit | + link row |
| `enterprise.occurrence_verification` | reviewer decisions with weight | retargeted by FK (§4) |
| `enterprise.evidence_tier`, `deposit_model`, `geologic_time`, `taxonomy*` | weighting and classification | none |
| `enterprise.sensor`, `sensor_capture`, `sensor_file` | future geophysics | none |
| `geo.*` (all) | **Layer 1, read-only** | none, ever |
| `geo.geological_assessment` + evidence graph | Layer 4 reasoning | subject rescope (§4) |
| `ml.ml_model`, `ml_feature`, `ml_score` | future scoring | none |

**16 of the 21 model groups are reused with no schema change.** That is the
whole argument for evolving rather than rebuilding.

---

## 3. The four permanent knowledge layers

Separation is enforced by *storage and write paths*, never by convention.

| | Layer | Storage | Who may write | Rule |
|---|---|---|---|---|
| **L1** | Official geological knowledge | `geo.*` server; immutable offline pack on device | ingestion scripts only | No app code path writes here. Ever. |
| **L2** | Field observations | `enterprise.*` observation tables | the observer | A fact about where somebody stood. No commodity claim. |
| **L3** | **Geological Sites** | `enterprise.geological_site` (new) | the observer, refined by AI/review | A *thing on the ground*. Persists across expeditions. |
| **L4** | Luul Scan Discoveries | `enterprise.discovery` + evidence graph | engine proposes, humans promote | An interpretation. Every claim traces to evidence. |

The load-bearing invariant, already in the codebase
(`lib/exploration/localEvidence.ts`): *"a waypoint never becomes a published
occurrence, it stays an observation with its own provenance."* v2 preserves it
structurally — L3 and L4 objects **reference** L2 rows; there is no
promote-in-place path anywhere in the schema.

---

## 4. Layer 3 — the Geological Site

*(Deliverable 5.)*

### 4.1 What a site is, precisely

The three concepts are easy to blur, so they are defined by *what changes them*:

| Concept | Definition | Lifetime | Changes when |
|---|---|---|---|
| **Observation** | One act of looking. *"At 09:41 I stood at X and saw quartz float."* | Immutable | Never. It is a historical fact. |
| **Geological Site** | A thing on the ground. *"This quartz vein."* | Permanent, revisitable | New observations accumulate on it; its geometry is refined |
| **Exploration Area** | The ground investigated. *"The 6 km² we covered in March."* | Grows | More ground is walked |
| **Discovery** | An interpretation about a site. *"This vein shows evidence consistent with tin."* | Versioned | New evidence, review, lab results |

**The site is what makes knowledge accumulate.** An observation is finished the
moment it is recorded. A site is revisited: three expeditions across a year
attach to the *same vein*, and its interpretation strengthens each time. Without
this layer, every visit starts from zero — which is exactly the problem with the
current model.

### 4.2 Schema

```sql
enterprise.geological_site (
  id             uuid pk,
  area_id        uuid null → exploration_area,   -- may be created before an area exists
  project_id     uuid null → project,
  discovered_on  uuid null → expedition,          -- the expedition that first found it
  site_type      enterprise.site_type not null,   -- §4.3
  name           text,                            -- "Vein 3", geologist's own name
  geom           geometry(Geometry,4326) not null, -- Point | LineString | Polygon
  strike_deg     numeric(5,2),  dip_deg numeric(5,2),   -- when structural
  host_lithology text,                            -- from L1 at this location, cached
  geological_unit_id text,                        -- the Macrostrat unit it sits in
  status         text check (active|exhausted|abandoned|merged),
  merged_into    uuid null → geological_site,     -- §4.4
  confidence     numeric(5,2),                    -- engine-computed only
  created_by     uuid → auth.users,
  created_at, updated_at, deleted_at
)

enterprise.site_visit (          -- the accumulation record
  id           uuid pk,
  site_id      uuid not null → geological_site,
  expedition_id uuid not null → expedition,
  visited_at   timestamptz not null,
  contributor_id uuid → auth.users,
  notes        text,
  primary key-ish unique (site_id, expedition_id)
)
```

Observations and samples gain `site_id` (nullable): an observation may exist
without a site, but a site is exactly *what a set of observations is about*.

### 4.3 Site types — from the existing vocabulary

`enterprise.site_type` is a new enum, but built from terms the schema already
uses so nothing is invented:

```
vein, quartz_vein, pegmatite, fault_exposure, shear_zone, contact,
alteration_zone, gossan, outcrop, float_train, old_workings, mine_entrance,
spring, placer, other
```

The first six map one-for-one onto `structure_type`; `alteration_zone` carries
an `alteration_type`. The mobile app's ten waypoint types (`outcrop`, `float`,
`quartz-vein`, `vein`, `sulfides`, `gossan`, `alteration`, `fault`, `contact`,
`other`) map onto this set without loss — an existing waypoint can therefore
*propose* a site, which is the natural upgrade path for data already on devices.

### 4.4 Site identity — the hard problem, answered

If two expeditions record "a quartz vein" 40 m apart, is that one site or two?
Getting this wrong either fragments the knowledge base or silently merges
distinct veins.

**Rule: the app proposes, the geologist decides. It never merges silently.**

1. On recording, search for existing sites within a tolerance derived from the
   GPS accuracy of the moment (not a fixed radius) **and** of a compatible type.
2. If a candidate exists, ask plainly: *"Is this the same vein you recorded on
   14 March, 40 m north?"* with both on the map.
3. Confirm → a `site_visit` row on the existing site. Reject → a new site.
4. Merging later is possible and reversible: `merged_into` keeps both rows, so a
   merge never destroys the original records or their provenance.

Nothing here guesses. A wrong automatic merge would be a fabricated geological
statement, which §10 forbids.

---

## 5. The object chain and the promotion ladder

```
Project ──► Mission (plan)          [EXISTS, unused]
              │
              ▼
          Expedition (actual field work, AUTOMATIC)      [NEW §6]
              │
              ├──► Survey Track            LineString    [EXISTS, unused]
              ├──► Field Observations      Pt/Line/Poly  [GENERALISE §7]
              └──► Samples                 Point         [EXISTS, in use]
                        │
                        ▼
              Exploration Area (derived ground)          [EXISTS, unused]
                        │
                        ▼
              Geological Site  ◄── observations, samples, photos accumulate
                        │            across many expeditions
                        ▼
              AI Site Interpretation → evidence graph    [RESCOPE §8]
                        │
                        ▼
              Prospect Candidate ──► Published Discovery ──► Verified Prospect
                        ▲                                          │
                   AI ceiling                                      ▼
                                                          Confirmed Deposit
                                                        (lab_result required)
```

### 5.1 Two orthogonal axes, not one

A single status column would conflate *how strong the evidence is* with *who has
checked it*. The schema already separates these, and v2 keeps them separate:

| Axis | Column | Values | Moved by |
|---|---|---|---|
| **Maturity** (evidence class) | `discovery.status` | prospect_candidate → published → verified_prospect → confirmed_deposit | evidence + RPC guard |
| **Verification** (who agreed) | `discovery.verification_state` *(existing enum)* | unverified → community_confirmed → expert_verified → lab_verified | reviewers |

### 5.2 Enforcement — four independent guards

Because a prompt is a request, not a guarantee:

1. **Check constraint** on `discovery.status`.
2. **RPC-only transitions** — `enterprise.advance_discovery()`. The app cannot
   `update` the column; this mirrors how `submit_sample` and `review_sample`
   already work.
3. **Evidence preconditions in the RPC**: `confirmed_deposit` is rejected unless
   a linked `lab_result` with `accredited = true` exists; `verified_prospect` is
   rejected without a second reviewer of the required role (RBAC exists, 0073).
4. **Vocabulary cap, server-side.** The engine's strongest permitted wording is
   *"evidence consistent with …"*. Validated in `save_assessment` — not left to
   the prompt. Every promotion writes `audit_action='promote'`, a value that
   already exists in the audit enum.

**AI can create a Prospect Candidate. AI cannot create anything above it.**

---

## 6. Expedition — automatic, invisible

*(Deliverable 3: which mobile models become parents.)*

The user never manages an expedition. The rule is one line: **an expedition is
the server-side identity of an exploration session, and that session already
exists.**

`ExplorationOrchestrator.explorationSessionId` already scopes the track and is
already created on Start and cleared on Stop. It becomes `device_session_id`.

| Today (device-only) | Becomes | Parent of |
|---|---|---|
| `explorationSessionId` | **Expedition** | everything captured while it runs |
| `TrackRecorder` points | `survey_track` | — |
| `WaypointStore` records | `field_observation` | may belong to a site |
| Samples via `new-sample` | `enterprise.sample` | gains `expedition_id`, `site_id` |

```
Open map → Start Exploration → expedition opens (local first)
   → every capture inherits expedition_id automatically
→ Stop → expedition closes, area proposed, sync drains
```

Lifecycle edge cases, decided now rather than discovered later:

- **App killed mid-expedition:** the session id is persisted with the outbox;
  on next launch the expedition is resumed, not duplicated.
- **Multi-day campaign:** one expedition per continuous session. Several
  expeditions may attach to one mission — that is what missions are for.
- **No signal for a week:** everything queues locally; the expedition uploads
  whole, idempotent by `(device_session_id, local_id)`.
- **Nothing found:** the expedition still uploads, with `no_mineralization`
  observations. Negative coverage is knowledge.

---

## 7. The map as the operating system

*(Deliverable 6. This is the largest change on the mobile side.)*

### 7.1 The architectural rule

> **No navigation may unmount the map.** Screens become surfaces that float on a
> map which never stops running.

Today `exploration.tsx` owns the map, and every other activity is a `router.push`
to a sibling screen. The capture round trip already returns to the live session
(`from=exploration` → `analysed=<id>`), which proves the pattern works — but the
map is rebuilt behind it and each new activity would repeat the problem.

### 7.2 The structure

```
app/(app)/explore/_layout.tsx        ← ExplorationProvider + MapWorkspaceProvider
    │                                  + the MAP host live here
    ├── index.tsx                    ← the sheet (today's exploration screen)
    ├── site/[id].tsx                ← surface over the map        [S4]
    ├── area/[id].tsx                ← surface over the map        [S5]
    ├── discovery/[id].tsx           ← surface over the map        [S7]
    └── draw.tsx                     ← line/polygon drawing state  [S3]
```

The layout route holds the map surface and the session; children render *above*
it. Moving between them changes what floats, never what runs. The expedition,
the GPS watch, the track recorder and the WebView canvas survive every
navigation.

**As built (S1): `<Slot/>`, not a nested `<Stack/>`.** A nested native stack
paints its own opaque background over the map — the exact thing this layout
exists to prevent — and it would put push/pop chrome between surfaces of a
single workspace. `Slot` renders the matched child straight into the map host, so
the child's own root view decides its transparency. Routes still exist and still
deep-link. If a later slice needs stacked surfaces with animation, that is a
decision to make with a device in hand, not by default.

Two mechanisms enforce the principle rather than describing it:

- `lib/exploration/workspace.tsx` holds the scene, camera, layers, tiles, tapped
  feature, track and fix. All of it used to live in the screen, which is why all
  of it died with a route.
- `lib/__tests__/mapFirstArchitecture.test.ts` asserts the structure: the map is
  mounted by the layout, no surface imports the map, and the capture flow pops
  back to the running workspace instead of `replace`-ing a second one on top of
  it. The old failure mode was invisible at runtime — a second provider and a
  second GPS watch, with the first still running underneath.

### 7.3 Map editing

Everything is created from the map, using input that already exists — the map
already reports taps as geographic coordinates with a fingertip tolerance
(`onPick` → `MapPick`), so drawing is a state machine over an existing channel,
not new plumbing.

| Object | Geometry | How it is drawn |
|---|---|---|
| Sample, waypoint | Point | tap, or "here" from the fix |
| Quartz vein, fault trace, contact | Line | tap vertices, **or walk it** (TrackRecorder) |
| Alteration zone, outcrop, prospect | Polygon | tap vertices, or walk the boundary |
| Exploration area | MultiPolygon | derived (§9), then refined by dragging |

Every object appears on the map the instant it is created (local write first,
sync later) and stays editable: geometry, type, name, notes.

### 7.4 Continuity

One `ExplorationContext` — expedition, current area, current site, active target
— readable by every surface. The capture flow keeps its current behaviour and
gains a parent: a photo taken while a site is selected belongs to that site
without anyone choosing it from a list.

---

## 8. AI interpretation at site scope

*(Deliverable 4, in part.)*

The evidence graph is correct and stays. Only its *subject* changes:

```sql
alter table geo.geological_assessment
  alter column sample_id drop not null,
  add column subject_kind text not null default 'sample'
      check (subject_kind in ('sample','site','area')),
  add column site_id uuid null references enterprise.geological_site(id),
  add column area_id uuid null references enterprise.exploration_area(id),
  add constraint ck_assessment_subject
    check ((sample_id is not null)::int + (site_id is not null)::int
         + (area_id is not null)::int = 1);
```

Existing rows keep `sample_id` and default to `'sample'`. `assessment_evidence`,
`assessment_conclusion` and `assessment_edge` need **no change** — they hang off
`assessment_id`.

New edge function `analyze-site` gathers, for one site:

- every observation, sample, photo and note attached to it, **across all
  expeditions that visited it**;
- Layer 1 context for its geometry (not a point): unit, age, lithology, fault
  proximity and trend, DEM, slope, aspect, drainage, MRDS occurrences,
  knowledge rules, mineral associations;
- prior assessments of the same site — the `prior_sample` evidence type already
  exists in the GIE contracts and is currently unused.

It reuses `EvidenceNode`, `scoreConclusion` and `overallConfidence` unchanged.
The confidence maths is not reimplemented, because reimplementing it is how two
different numbers start appearing for the same evidence.

**One new rule the per-sample engine cannot have — agreement.** Several samples
supporting the same conclusion on the same mapped unit raise confidence;
contradiction between them lowers it and is surfaced as an *alternative
interpretation* rather than being hidden. This is the difference between "six
photos" and "a site".

---

## 9. Exploration Areas — derived, not drawn

Boundaries come from what was actually done:

1. Take the walked track(s) and the located observations/samples of the
   expedition.
2. Compute their concave hull, buffered by the median GPS accuracy of the
   points (the uncertainty is real; the boundary should carry it).
3. **Clip to the mapped geological unit(s)** from Layer 1, so the area is a
   geological statement — "this part of this unit" — rather than a shape.
4. Optionally split where a mapped fault crosses it.
5. Present it for refinement; the user may drag, extend or reject before saving.

No arbitrary circles. An area with no walked ground cannot be created.

---

## 10. Provenance and scientific integrity

Every discovery permanently records, as foreign keys rather than free text:
mission, expedition, area, site, sample ids, photo ids, observation ids,
assessment id, engine version, model, creator, timestamps, and each evidence
row's dataset and tier.

```sql
enterprise.discovery_evidence (
  discovery_id, ref_type check (sample|observation|site|track|photo|
                                lab_result|assessment|external_reference),
  ref_id, role check (supporting|contradicting|context),
  primary key (discovery_id, ref_type, ref_id)
)
```

A discovery with no `discovery_evidence` rows **cannot be published** — enforced
in the RPC, not in the UI.

The integrity rules, restated as engineering constraints:

| Rule | Mechanism |
|---|---|
| Never fabricate geology | L1 is read-only; no write path exists |
| Never fabricate a deposit | `advance_discovery` requires an accredited lab result |
| Never fabricate a discovery | publish requires evidence rows |
| Never invent confidence | confidence is computed by `scoreConclusion`; there is no user-settable field |
| Every statement traceable | `assessment_edge` links every conclusion to its evidence |
| Absence is recorded too | `finding_type='no_mineralization'` |

---

## 11. Migrations required

*(Deliverable 4.)* Additive and idempotent, in the style of the existing 94.

| # | Migration | Risk |
|---|---|---|
| 1 | `enterprise.expedition`; nullable `expedition_id` on sample, track, observation | none — additive |
| 2 | `enterprise.field_observation` (mixed geometry) + view `field_observation_point` for compatibility | low — no current writers |
| 3 | `enterprise.site_type` enum; `enterprise.geological_site`; `enterprise.site_visit`; `site_id` on sample and observation | none |
| 4 | `geo.geological_assessment` subject rescope (§8) | **medium** — §12 |
| 5 | `enterprise.discovery` + `discovery_evidence` + RLS mirroring `0036_area_policies` | none |
| 6 | RPCs: `open_expedition`, `close_expedition`, `upsert_observation`, `upsert_site`, `merge_sites`, `create_area_from_expedition`, `save_site_assessment`, `create_discovery`, `advance_discovery` | none |
| 7 | `structural_measurement.site_id` / `observation_id` nullable, so structure can be recorded without a sample | low |
| 8 | Retarget `occurrence_verification.occurrence_id` → `discovery_id` (or add a parallel `discovery_verification`) | low — unused table |

**Not migrated:** the offline pack format. `PACK_FORMAT_VERSION` stays 1. L3/L4
objects never enter a pack; they reach the device through the API as their own
map layers.

---

## 12. Backward compatibility

| Risk | Mitigation |
|---|---|
| `geological_assessment.sample_id` nullable | Only `analyze-sample`, `enterprise-samples` and `ReviewSample.tsx` read it; add `subject_kind='sample'` to those queries in the same change |
| Samples with no expedition or site | Both FKs nullable, no backfill. A historical sample is valid, not broken |
| Waypoints already on devices (`field.waypoints.v1`) | Key and shape preserved; optional `serverId`/`siteId`/`syncedAt` added. The store already merges unknown fields safely |
| Installed offline packs | Untouched |
| Review console | Sample-scoped views keep working; site and discovery reviews are new views |
| Invariant 6 | Structurally preserved — no promote-in-place path exists |
| RLS | New tables reuse the existing area/sample policy predicates |
| Map performance | L3/L4 layers are additional map layers, subject to the same viewport culling and LOD as the pack layers |

---

## 13. How the existing Exploration Engine fits

*(Deliverable 7.)*

| Component | Role in the platform | Change |
|---|---|---|
| `PackStore`, `bundledPack`, `packGateway` | **Layer 1 on the device** | none |
| `OfflineGeoContextService` | L1 context for guidance and for site assessment inputs | none |
| `TargetingEngine`, `expedition.ts` (regional targets), `orientation.ts` | where to walk next | + sites and discoveries as target sources |
| `ExplorationOrchestrator` | session state machine | + opens/closes the Expedition |
| `FieldSessionController`, `locationService`, `headingService` | sensors | none |
| `TrackRecorder` | the traverse | + emits `survey_track`; + supplies vertices for walked geometry |
| `WaypointStore` / `WaypointService` | L2 observations | + `site_id`, + outbox sync |
| `localEvidence.ts` | feeds observations back into targeting | + site- and discovery-derived evidence |
| `ExplorationMap` (WebView canvas) | **the workspace** | + editable L2/L3/L4 layers, drawing mode; hoisted to the layout route |
| `featureInfo.ts` (tap to identify) | identify across all four layers | + site/discovery hit-testing |
| `fieldAdvice.ts` | rolling guidance | + "you are near Vein 3, last visited in March" |
| `useMapTiles`, `tileCache` | raster backdrop | none |
| `field-camera`, `new-sample`, `shotNeeds` | capture | + inherits expedition/site parents |
| `shared/geo-core/gie` | reasoning | reused verbatim at site scope |
| Review console | review | + site/discovery queues |

Nothing on this list is discarded.

---

## 14. Scalability check

| Later requirement | Supported by | New tables |
|---|---|---|
| Multiple geologists | `area_membership`, `mission_contributor`, RBAC | none |
| Shared projects / company campaigns | `project`, `organization`, missions | none |
| Laboratory assays | `lab_result` + `discovery_evidence` link | none |
| Drill holes | a site of type `drill_hole` + collar point and downhole path | one |
| Trenching | site type `trench`, polygon geometry | none |
| Geochemical surveys | samples + `lab_result`; negative grid via `no_mineralization` | none |
| Geophysics | `sensor`, `sensor_capture`, `sensor_file` already exist | one reading table |
| Satellite interpretation | an assessment with `subject_kind='area'` and remote-sensing evidence | none |

No redesign is required for any of these.

---

## 15. Build order

Each slice ships independently and leaves the app working.

Order approved at review: **Map-as-OS first.** Every later slice is a surface
over the map, so building them before the workspace exists means building them
twice.

| Slice | Delivers | Why this order |
|---|---|---|
| **S1** | **Map as Operating System**: the map and the exploration session hoisted to a layout route; existing screens become surfaces over a map that never unmounts | Principle 0.2. Every later slice depends on it |
| **S2** | Expedition + sync outbox. The session, its track and its observations survive the walk and reach the server | Today every walk is discarded. Nothing can accumulate until this exists |
| **S3** | `field_observation` with real geometry + drawing tools (tap vertices, walk the boundary) | Sites need geometry |
| **S4** | **Geological Site**: creation, identity matching, revisits, site surface over the map | The accumulation layer |
| **S5** | Exploration Area derived from the expedition, refinable | Needs S2 + S3 |
| **S6** | `analyze-site` + assessment rescope + the agreement rule | Needs S4 |
| **S7** | Discovery: creation from an assessment, provenance, the promotion ladder and its guards | Needs S6 |
| **S8** | Review, verification and lab linkage in the console; `confirmed_deposit` becomes reachable — only through evidence | Needs S7 |

S1 and S2 are the foundations; S4 is the concept that makes the platform
different from a map with notes.

Each slice ships and is reviewed before the next begins.

---

## 16. Open decisions for review

1. **Site type as enum vs taxonomy table.** Proposed: enum (closed, fast,
   matches existing style). `enterprise.taxonomy_node` exists and would allow
   user-extensible types at the cost of a join — recommended only if geologists
   must add their own types in the field.
2. **Site identity tolerance.** Proposed: derived from GPS accuracy at the
   moment of recording, with user confirmation always. Alternative: a fixed
   radius per site type.
3. **Area required for a site?** Proposed: no — a site may exist before any area
   is derived, and gets attached when the area is created. Simpler for the
   geologist, one nullable FK for us.
4. **Discovery visibility before publishing.** Proposed: visible to area members
   as a draft, so a team does not duplicate work. Alternative: private to the
   creator.
5. **Where the AI ceiling is enforced for wording.** Proposed: both prompt and
   server validator. The validator is the one that counts.
6. **Voice notes.** Proposed: store audio now, transcribe later. The recording is
   the record.

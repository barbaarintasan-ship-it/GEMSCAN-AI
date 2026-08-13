# Luul Scan — Exploration Platform Architecture v1

**Status:** proposal. No implementation code has been written.
**Scope:** evolving Luul Scan Exploration from a map + sample tool into a
knowledge-producing exploration platform, by refactoring what exists rather than
rewriting it.

---

## 0. The finding that shapes everything below

Before proposing anything, the existing system was surveyed: 94 migrations, the
`enterprise`/`geo`/`ml` schemas, 28 edge functions, the mobile exploration
engine and the review console.

**Most of the requested object model already exists in the database and is not
used by any code.**

| Requested entity | Already in the schema | Written by any code? |
|---|---|---|
| Exploration Area (boundary polygon, history) | `enterprise.exploration_area` — MultiPolygon boundary, centre, confidence, verification state, project scoping, `area_membership` | **No** |
| Expedition / campaign | `enterprise.exploration_mission` + `mission_area`, `mission_contributor`, `mission_assignment`, `mission_progress` | **No** |
| GPS tracks | `enterprise.survey_track` — LineString, area, mission, h3 cells | **No** |
| Field observations | `enterprise.field_observation_point` — finding type (**including `no_mineralization`**), optional sample link | **No** |
| Structural measurements | `enterprise.structural_measurement` — strike/dip/dip-direction with range checks | Read-only in the sample DTO |
| Laboratory results | `enterprise.lab_result` — assay jsonb, grade g/t, accredited flag | **No** |
| Area-level evidence + review | `enterprise.occurrence_evidence`, `occurrence_verification` (reviewer weighting) | **No** |
| Evidence graph | `geo.geological_assessment` + `assessment_evidence` + `assessment_conclusion` + `assessment_edge` | **Yes — but sample-scoped only** |
| Official geology (Layer 1) | `geo.*` (mineral_occurrence, geological_layer with mixed geometry, terrain_cell, commodity_profile, knowledge rules…) | Yes, read-only |

So this is not a redesign. It is **connecting a designed-but-dormant model to a
working app**, plus four genuinely new pieces (§4).

The one structural mistake to avoid: treating the mobile exploration session as
a throwaway UI state. Today the session id, the track and the waypoints live
only on the device (`AsyncStorage: field.waypoints.v1`, `TrackRecorder` in
memory). Everything the platform wants to accumulate is being discarded at the
end of every walk.

---

## 1. The three layers, and where each one lives

The separation is not a convention to remember — it must be enforced by
*storage*, so that mixing them is impossible rather than merely discouraged.

### Layer 1 — Official geological knowledge (read-only)

**Storage:** `geo.*` on the server; the immutable offline pack on the device.

Macrostrat units, MRDS occurrences, faults, contacts, DEM/terrain cells,
drainage, commodity profiles, knowledge rules, raster registry.

**Rules, already in force and unchanged:**
- The pack is a derived artifact: immutable, versioned, replaced wholesale
  (Architecture Invariant 1). A discovery is **never** written into a pack.
- Nothing a user does can modify Layer 1. There is no code path from the app to
  a `geo.*` write, and none is added.

### Layer 2 — Field observations (raw, owned by the observer)

**Storage:** `enterprise.*` observation tables.

| Observation | Table | Geometry |
|---|---|---|
| Sample | `enterprise.sample` (+ `sample_media`, `sample_location`, `sample_device_context`) | Point |
| Waypoint / finding | `enterprise.field_observation_point` → **generalised to `field_observation`** (§4.3) | Point / Line / Polygon |
| GPS track | `enterprise.survey_track` | LineString |
| Structural measurement | `enterprise.structural_measurement` | attached to a sample **or** an observation (§5.4) |
| Rock / mineral / alteration observations | `rock_observation`, `mineral_observation`, `alteration_observation` | attached to a sample |
| Photos | `enterprise.sample_media` + storage bucket | — |
| Notes / voice notes | new column + media role (§4.3) | — |

**Rule:** an observation is a fact about where somebody stood and what they saw.
It carries no interpretation and no commodity claim. `localEvidence.ts` already
encodes this (Invariant 6: *"a waypoint never becomes a published occurrence, it
stays an observation with its own provenance"*), and the new model keeps it —
a Discovery **references** observations, it is never a promoted one.

### Layer 3 — Luul Scan Discoveries (interpretation, with provenance)

**Storage:** new `enterprise.discovery` (§4.2) + the **existing** evidence graph
(`geo.geological_assessment` and friends), rescoped from sample to subject.

A discovery is an interpretation produced from accumulated evidence. It is the
only place where a commodity claim may appear, and every claim links back to
evidence rows.

---

## 2. The object chain

```
Project ─────────────► (optional; company campaigns)
   │
   ├── Exploration Mission ────► plan: targets, roster, assignments   [EXISTS]
   │        │
   │        └── Expedition ────► one field campaign / outing          [NEW §4.1]
   │                 │
   │                 ├── Survey Track          (LineString)           [EXISTS, unused]
   │                 ├── Field Observations    (Pt / Line / Polygon)  [GENERALISE §4.3]
   │                 ├── Samples               (Point)                [EXISTS, in use]
   │                 └── Notes / voice / photos                       [EXTEND]
   │
   └── Exploration Area ───────► the investigated ground              [EXISTS, unused]
            │                     boundary derived from the above
            │
            ├── Area Assessment  (AI over the WHOLE area)             [RESCOPE §4.4]
            │        └── evidence graph: evidence → edges → conclusions [EXISTS]
            │
            └── Discovery ──────► Layer 3 object                       [NEW §4.2]
                     │
                     ├── status ladder (§3)
                     ├── provenance (expedition, area, samples, photos,
                     │               waypoints, assessment, engine version)
                     └── Lab Result ──────► promotes the status        [EXISTS, unused]
```

Nothing is isolated: every arrow is a foreign key, and the evidence graph makes
the reasoning itself traversable.

---

## 3. The status ladder — enforced, not documented

This is the safety property of the whole platform. AI image analysis must never
be able to declare a deposit.

| Status | What justifies it | Who may set it |
|---|---|---|
| `prospect_candidate` | An area assessment with supporting evidence | **AI (engine) — this is its ceiling** |
| `published` | The geologist reviewed the candidate and stands behind it | Creator / area member |
| `verified_prospect` | Independent review by a second qualified reviewer | Reviewer role (RBAC exists) |
| `confirmed_deposit` | External evidence: accredited `lab_result`, drilling, trenching | Reviewer **and** a linked accredited lab result |

Enforcement, in this order:

1. **Check constraint** on the status column.
2. **RPC-only transitions** (`enterprise.advance_discovery(...)`) — the app never
   updates the column directly, exactly as `submit_sample` / `review_sample`
   already work.
3. The RPC **rejects** `confirmed_deposit` unless an `enterprise.lab_result` with
   `accredited = true` is linked; it rejects any AI-authored transition above
   `prospect_candidate` by checking the caller role.
4. Language: the engine's own vocabulary is capped. The strongest wording it may
   emit is *"area showing evidence consistent with …"*. This belongs in the
   analysis prompt **and** in a server-side validator, because a prompt is a
   request, not a guarantee.

---

## 4. What is genuinely new

### 4.1 Expedition — the execution record

`exploration_mission` is a **plan** (targets, roster, coverage). An expedition is
**one campaign actually walked**. They are different lifetimes: a mission may
span many expeditions, and most solo expeditions have no mission at all.

```sql
enterprise.expedition (
  id                uuid pk,
  project_id        uuid null → project,
  mission_id        uuid null → exploration_mission,   -- optional plan
  area_id           uuid null → exploration_area,      -- set when the area is created
  name              text,
  device_session_id text,        -- the mobile ExplorationOrchestrator session id
  started_at        timestamptz not null,
  ended_at          timestamptz,
  status            text check (planned|active|completed|abandoned),
  distance_m        double precision,   -- from TrackRecorder stats
  moving_ms         bigint,
  created_by        uuid → auth.users,
  ...
)
```

`device_session_id` is the join between the offline session and the server
record — it makes the sync idempotent and lets an expedition be uploaded long
after it was walked.

Everything collected in the field gains a nullable `expedition_id`.

### 4.2 Discovery — the Layer 3 object

```sql
enterprise.discovery (
  id                 uuid pk,
  area_id            uuid not null → exploration_area,
  expedition_id      uuid null → expedition,
  assessment_id      uuid null → geo.geological_assessment,   -- the AI interpretation
  project_id         uuid null → project,
  title              text not null,
  geom               geometry(Geometry,4326) not null,  -- point OR polygon
  commodities        text[] not null,      -- FK-validated against geo.commodity
  host_lithology     text null,
  status             text not null,        -- the ladder, §3
  confidence         numeric(5,2),         -- ENGINE-computed; never user-entered
  reasoning          jsonb,                -- bilingual; conclusions + alternatives
  next_work          jsonb,                -- recommended follow-up
  engine_version     text,
  created_by         uuid → auth.users,
  created_at, updated_at, deleted_at
)

enterprise.discovery_evidence (        -- provenance, many-to-many
  discovery_id  uuid → discovery,
  ref_type      text check (sample|observation|track|photo|lab_result|assessment),
  ref_id        uuid,
  role          text check (supporting|contradicting|context),
  primary key (discovery_id, ref_type, ref_id)
)
```

`discovery_evidence` is the provenance requirement made structural: a discovery
with no rows here cannot be published — enforced in the publish RPC.

Review reuses the existing `occurrence_verification` pattern (reviewer, level,
decision, weight) rather than inventing a second review system.

### 4.3 Field observation with real geometry

`field_observation_point` is Point-only. Quartz veins are lines; alteration
zones and outcrops are polygons. Rather than a table per shape, follow the
precedent already set by `geo.geological_layer`, which stores mixed geometry:

```sql
enterprise.field_observation (
  id, area_id, expedition_id, survey_track_id, contributor_id,
  object_type  text not null,     -- outcrop|quartz_vein|fault|contact|alteration|
                                  -- float|shear_zone|gossan|sulfides|river|other
  geom         geometry(Geometry,4326) not null,
  finding      enterprise.finding_type not null,   -- incl. no_mineralization
  sample_id    uuid null → sample,
  notes        text,
  voice_uri    text,
  h3_cell      text not null,
  gps_accuracy_m double precision,   -- as reported, never rounded
  captured_at  timestamptz not null,
  ...
  constraint ck_geom_matches_type check (…)   -- vein ⇒ LineString, zone ⇒ Polygon
)
```

`field_observation_point` is kept as a **view** over this table for
compatibility, and the existing 10 mobile waypoint types map onto `object_type`
one-for-one.

### 4.4 Area-level AI interpretation

The evidence graph is already correct — it is simply attached to the wrong
subject. `geo.geological_assessment.sample_id` is `not null`.

```sql
alter table geo.geological_assessment
  alter column sample_id drop not null,
  add column area_id uuid null references enterprise.exploration_area(id),
  add column subject_kind text not null default 'sample',
  add constraint ck_assessment_subject
    check ((sample_id is not null)::int + (area_id is not null)::int = 1);
```

Existing rows keep `sample_id` and default to `subject_kind='sample'`. Nothing
breaks. `assessment_evidence`, `assessment_conclusion` and `assessment_edge`
need **no change at all** — they hang off `assessment_id`.

A new edge function `analyze-area` then:

1. Gathers every sample, observation, photo and note inside the area boundary.
2. Calls the **existing** GeoContext providers once for the area rather than per
   point (unit, age, lithology, fault proximity, drainage, DEM, MRDS, knowledge
   rules, associations).
3. Emits `EvidenceNode[]` using the **existing** `shared/geo-core/gie` contracts
   — including the `prior_sample` evidence type, which exists and is unused.
4. Scores with the **existing** `scoreConclusion` / `overallConfidence`. The
   confidence maths is not reimplemented.
5. Adds one aggregation rule that per-sample analysis cannot have:
   **agreement**. N samples supporting the same conclusion on the same mapped
   unit raise confidence; contradiction between them lowers it and is reported
   as an alternative interpretation rather than hidden.

Reused as-is: `analyze-sample`'s Gemini plumbing, bilingual output, the
`input_hash` idempotency pattern, `mark_analysis_progress`, and the failure
states from `0092_ai_failed_status`.

---

## 5. Migrations required

Additive and idempotent, in the style of the existing 94.

| # | Migration | Risk |
|---|---|---|
| 1 | `enterprise.expedition` + nullable `expedition_id` on sample / track / observation | None — additive |
| 2 | `enterprise.field_observation` (mixed geometry) + compatibility **view** named `field_observation_point` | Low — the old table has no writers |
| 3 | `geo.geological_assessment`: `sample_id` nullable, `+ area_id`, `+ subject_kind`, check constraint | **Medium** — see §6 |
| 4 | `enterprise.discovery` + `discovery_evidence` + RLS mirroring `area_policies` / `sample_policies` | None |
| 5 | RPCs: `create_expedition`, `close_expedition`, `upsert_observation`, `create_area_from_expedition`, `save_area_assessment`, `create_discovery`, `advance_discovery` | None |
| 6 | `structural_measurement.observation_id` (nullable) so structure can be recorded without a sample | Low |
| 7 | Storage bucket policy for voice notes | None |

Deliberately **not** migrated: the offline pack format. Layer 3 never enters a
pack; discoveries reach the device through the normal API and are drawn as their
own map layer.

---

## 6. Backward compatibility

| Risk | Mitigation |
|---|---|
| `geological_assessment.sample_id` becoming nullable — code assuming it is present | Only `analyze-sample`, `enterprise-samples` and `ReviewSample.tsx` read it. All three filter by sample; add `subject_kind='sample'` to those queries in the same PR as the migration. |
| Existing samples have no expedition | `expedition_id` nullable, no backfill. A sample without an expedition is a valid historical record, not an error. |
| Mobile waypoints in `AsyncStorage: field.waypoints.v1` | Keep the key and the shape; add optional `serverId` / `syncedAt`. The store already merges unknown fields safely (same pattern as `layerPrefs.mergeLayers`). |
| Offline pack v1 on installed devices | Untouched. `PACK_FORMAT_VERSION` stays 1. |
| Review console reading sample-scoped assessments | Area assessments are a new view; the sample view keeps working unchanged. |
| Invariant 6 (observation ≠ occurrence) | Structurally preserved: `discovery` is a separate table that *references* observations. There is no promote-in-place path. |
| RLS | New tables mirror the existing `0036_area_policies` / `0037_sample_policies` predicates. No new policy model. |

---

## 7. Mobile architecture

What changes, and what does not.

**Unchanged (reused as-is):** `ExplorationOrchestrator`, `FieldSessionController`,
`TrackRecorder`, `WaypointStore` / `WaypointService`, `PackStore`, the targeting
engine, `localEvidence`, the map surface and its layers, the capture flow
(`field-camera` → `new-sample` → analysis → back to the live map).

**Changed:**

1. **The session becomes an expedition.** `explorationSessionId` — which already
   exists and already scopes the track — becomes `device_session_id`. Start of a
   session creates a local expedition row; end closes it.
2. **A sync outbox.** One append-only queue on the device: observations, track
   segments, expedition open/close, area creation, discovery drafts. Drains when
   online, idempotent by `(device_session_id, local_id)`. This is the only new
   subsystem of any size, and it is what makes offline-first real for Layer 2
   rather than just for Layer 1.
3. **Draw tools on the map.** Line and polygon capture: tap-to-add-vertex, or
   walk-the-boundary using the existing `TrackRecorder` points. The map already
   reports taps in geographic coordinates (`onPick`), so this is a drawing state
   machine over an existing input, not new plumbing.
4. **Area creation from the expedition.** Boundary proposed from what was
   actually done — the walked track plus the sampled points — then clipped to the
   mapped geological unit, then editable by the user before saving. No arbitrary
   circles.
5. **New map layers:** `field_observation` (Layer 2, own symbols per geometry),
   `discovery` (Layer 3, distinct symbol, colour by status). MRDS keeps its
   existing struck-circle symbol so official and interpreted never look alike.

---

## 8. Does it scale to the roadmap?

| Later requirement | Supported by | New tables needed |
|---|---|---|
| Multiple geologists | `area_membership`, `mission_contributor`, RBAC roles (0073) | none |
| Shared projects | `project`, `organization`, `organization_member` | none |
| Company campaigns | `exploration_mission` + assignments + progress | none |
| Laboratory results | `lab_result` (+ link row in `discovery_evidence`) | none |
| Drill holes | new `enterprise.drill_hole` as a Layer 2 observation with a collar point and a downhole path | one |
| Trenching | `field_observation` with `object_type='trench'` and a polygon | none |
| Geochemical surveys | sample + `lab_result`; grid = observations with `finding=no_mineralization` where negative | none |
| Geophysical surveys | new `enterprise.survey_reading` (sensor tables already exist: `sensor`, `sensor_capture`, `sensor_file`) | one |

The data model does not need redesigning for any of these, which is the test the
brief set.

---

## 9. Proposed build order

Each slice is shippable and leaves the app working.

| Slice | Delivers | Depends on |
|---|---|---|
| **S1** | Expedition object + sync outbox; the session, its track and its waypoints survive the walk and reach the server | migrations 1 |
| **S2** | `field_observation` with real geometry + map draw tools (line, polygon, walk-the-boundary) | migration 2 |
| **S3** | Exploration Area: derived boundary, user refinement, area screen reachable from the map | migrations 1–2 |
| **S4** | `analyze-area` + assessment rescope: one interpretation for the whole area, with the agreement rule | migration 3 |
| **S5** | Discovery: creation from an assessment, provenance, the status ladder and its RPC guards | migration 4–5 |
| **S6** | Review + verification in the console; lab result linkage; `confirmed_deposit` becomes reachable — only through evidence | existing review infra |

S1 alone is worth shipping on its own: today every walk is discarded.

---

## 10. Open decisions

1. **Expedition vs mission.** This proposes both: mission = plan (already built),
   expedition = execution. The alternative — reusing `exploration_mission` with a
   `kind` column — is fewer tables but conflates a plan with a record of what
   happened. Recommendation: keep them separate.
2. **Area boundary default.** Convex hull of the walked track + sampled points,
   buffered, then clipped to the mapped unit. Alternative: unbuffered hull.
   Recommendation: clip to the unit — it makes the area a geological statement
   rather than a shape.
3. **Discovery ownership before publish.** Private to the creator until
   published, or visible to area members immediately? Recommendation: visible to
   area members as a draft, so a team does not duplicate each other's work.
4. **Voice notes.** Transcribe on the server (adds a dependency) or store audio
   only? Recommendation: store first, transcribe later — the recording is the
   record.

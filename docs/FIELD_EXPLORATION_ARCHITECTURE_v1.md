# Field Exploration — Architecture v1

**Status:** For review — no implementation yet
**Date:** 2026-08-03
**Answers:** *What happens from the moment the user presses "Start Exploration" until the exploration session ends?*
**Extends:** GEOCONTEXT_ENGINE_ARCHITECTURE_v1, GEOLOGICAL_INTELLIGENCE_ENGINE_v1
**Consumes:** Field Exploration Engine Phase 1 (frozen)

---

## 0. Reading this document

**Part I — The Exploration Workflow (§1–§5)** is the architecture. It defines what the
product does, in order, from the user's point of view.

**Part II — Supporting Architecture (§6–§10)** is how that workflow is served: knowledge
packs, gateways, the reasoning core, cloud responsibilities. Every component in Part II
exists to serve a step in Part I. A component that cannot be traced to a workflow step
does not belong in this system.

**Part III — Delivery (§11–§15)** is migration, risks, and open decisions.

---

# PART I — THE EXPLORATION WORKFLOW

## 1. What the product does

LuulScan Enterprise Exploration is an **intelligent mineral exploration assistant** that
guides a geologist — possibly one with no formal training — toward the
highest-probability exploration target, **while holding a phone with no signal.**

It is not a GPS app, not a mapping app, not a data viewer, not a stone scanner. Those are
capabilities it uses.

The product is the **loop**: know where you are → know what is under you → be told where
to go and why → walk there → provide evidence → get a better recommendation → repeat.

### 1.1 The offline commitment

**Every step of the loop closes without network.** Cloud results arrive later and
*improve* the model; they are never a precondition for guidance.

This is not a degradation strategy. There is no "online mode" that works well and an
"offline mode" that limps. There is one mode, which runs on the device, and an optional
enrichment stream from the cloud.

---

## 2. The exploration session

### 2.1 Two state machines, composed — not merged

Phase 1 already owns a **sensor** state machine (`idle → requestingPermissions → starting
→ active ⇄ paused → stopping`). It is frozen and production-tested on real hardware.

The **exploration** session is a distinct machine that runs *on top of* an active field
session:

```
ExplorationState:
  idle → orienting → guiding ⇄ awaitingEvidence → reasoning → guiding … → summarising → ended
```

| Exploration state | Meaning |
|---|---|
| `orienting` | First fix in; computing "where am I and what is here" |
| `guiding` | A target is recommended; the user is walking |
| `awaitingEvidence` | Target reached; the app has asked for a photo/scan/observation |
| `reasoning` | Re-scoring after new evidence — local, sub-second |
| `summarising` | Session ending; assembling the traverse record |

**The exploration machine never duplicates sensor logic.** It observes the field session's
snapshot. If the field session pauses (user pause, app backgrounded) or errors (permission
revoked, GPS lost), exploration **suspends guidance** and resumes when the field session
does. There is exactly one GPS engine, one heading engine, one session controller.

### 2.2 The loop

```
   [ Start Exploration ]
             │
             ▼
   ┌─── 1. START SESSION ────────────────────────────────┐
   │  entitlement check · field session start            │
   │  pack activation + staleness check                  │
   └────────────────────┬────────────────────────────────┘
                        ▼
   ┌─── 2. ORIENT ───────────────────────────────────────┐
   │  first fix → H3 cell → local geological context     │
   │  "You are on Precambrian basement. 3 gold           │
   │   occurrences within 5 km."                         │
   └────────────────────┬────────────────────────────────┘
                        ▼
   ┌─── 3. TARGET ───────────────────────────────────────┐──┐
   │  rank neighbouring cells by prospectivity           │  │
   │  → bearing + distance + THE REASON WHY              │  │
   └────────────────────┬────────────────────────────────┘  │
                        ▼                                   │
   ┌─── 4. WALK ─────────────────────────────────────────┐  │
   │  heading arrow · position updates                   │  │
   │  re-target on cell change, not on every fix         │  │
   └────────────────────┬────────────────────────────────┘  │
                        ▼                                   │
   ┌─── 5. ARRIVE ───────────────────────────────────────┐  │
   │  target reached → app requests evidence             │  │
   └────────────────────┬────────────────────────────────┘  │
                        ▼                                   │
   ┌─── 6. CAPTURE ──────────────────────────────────────┐  │
   │  waypoint · photo · specimen scan                   │  │
   │  → local evidence node, stored offline              │  │
   └────────────────────┬────────────────────────────────┘  │
                        ▼                                   │
   ┌─── 7. RE-SCORE (offline, immediate) ────────────────┐  │
   │  evidence enters the graph → confidence recomputed  │  │
   │  → next best target                                 │──┘
   └────────────────────┬────────────────────────────────┘
                        ▼
   ┌─── 8. END SESSION ──────────────────────────────────┐
   │  traverse summary · queued for sync                 │
   └─────────────────────────────────────────────────────┘

   ⇅ CLOUD — asynchronous, never blocking:
     specimen images → deep verification → evidence tier upgrade → re-score
     session data → sync up      new packs → sync down
```

---

## 3. The steps in detail

### 3.1 Start session

1. **Entitlement check.** Enterprise access (see §14.4 — currently a private beta gate).
2. **Field session start** — `FieldSessionController.start()`. Phase 1 owns permissions,
   the services check, first-fix acquisition, and every error path. Nothing is reimplemented.
3. **Pack activation** — the installed knowledge pack is verified and its version and build
   date recorded into the session. If the pack is stale (§3.9), the session still starts;
   the staleness is surfaced, not suppressed.
4. An `explorationSessionId` is created and linked to the Phase 1 `sessionId`.

**Failure paths.** No permission / no GPS / services off are Phase 1 error states and are
presented as such. Exploration does not start without a field session, and does not invent
its own error vocabulary.

### 3.2 Orient — "where am I, and what is here?"

On the first non-provisional fix:

1. `lat, lng → H3 cell` at resolution 7 (~5.16 km), the same constant the server uses.
2. `GeoQuery{ lat, lng, radiusM, h3 }` runs against the local providers.
3. Fusion produces a `GeoContext` — identical in shape to the server's.
4. The user is told, in plain language, what they are standing on and what is near.

This must appear **within seconds, offline, on first launch**, with no download. It is the
first evidence to the user that the app knows something.

### 3.3 Target — "where should I go, and why?"

The TargetingEngine ranks the k-ring of cells around the current cell by prospectivity,
using the same deterministic scoring as the server (§8).

A recommendation is never a bare arrow. It carries **the reasoning that produced it**,
derived from the rule that fired:

> *"Head 800 m north-east. Granite–greenstone contact, and 3 gold occurrences lie within
> 5 km along this structural trend."*

**Requirement: no unexplained recommendation.** A user with no geological training is being
asked to walk somewhere; the reason is what makes this a professional instrument rather
than a divining rod. It is also what makes a wrong recommendation *auditable*.

### 3.4 Walk — continuous update

- The **heading engine** (Phase 1, built and until now unused) drives the bearing arrow.
- Position updates arrive under Phase 1's `WALKING_PROFILE` (15 m / 5 s), which already
  suppresses callbacks while the user stands still.

**Re-targeting policy — deliberate, not per-fix:**

| Trigger | Re-target? |
|---|---|
| H3 cell changes | ✅ |
| New evidence captured | ✅ |
| User pulls to refresh | ✅ |
| Target reached | ✅ (via arrival) |
| Every GPS fix | ❌ — battery, and thrashing recommendations |

Recommendation stability is a feature. A target that changes every ten metres is useless to
someone walking.

### 3.5 Arrive

Arrival is declared when the user is within an **accuracy-aware** radius of the target — the
threshold widens with GPS accuracy, so a ±40 m fix does not repeatedly claim arrival and
retract it.

On arrival, the app requests evidence appropriate to the target's reason: *"You should be
on the contact. Photograph the outcrop, or scan a specimen."*

### 3.6 Capture — evidence, offline

The user captures a waypoint, photo, or specimen scan. Each becomes a **local evidence
node**, stored on the device immediately:

| Capture | Evidence tier | Weight |
|---|---|---|
| Geologist-declared observation (waypoint type) | `field_observation` | 0.9 |
| On-device / unverified visual | `ai_visual` | 0.4 |

Milestone 2.1 already provides the waypoint half of this, with position-copy semantics and
`syncState` designed for exactly this role.

**This step must never wait for the network.** See §14.3 for the open decision on what
constitutes offline evidence.

### 3.7 Re-score — the loop closing

New evidence enters the evidence graph; confidence is recomputed by the same deterministic
tier-weighted noisy-OR the server uses; the TargetingEngine re-ranks.

**This is the step that makes it an assistant rather than a map.** It is also the step that
made precomputed context packs unusable — an answer computed before the user existed cannot
incorporate evidence that did not exist then (§7.1).

Latency budget: **sub-second, on device, offline.**

### 3.8 End session

`FieldSessionController.stop()` — Phase 1 owns teardown and the cleanup audit. The session
produces a traverse summary — track, waypoints, targets visited, evidence collected — and
queues it for sync.

### 3.9 Degraded paths

A field architecture is judged by what it does when things are missing.

| Condition | Behaviour |
|---|---|
| No GPS fix yet | Orientation waits; the app says so. It does not guess a location. |
| Fix stale or imprecise | Guidance continues, labelled with its quality. Arrival thresholds widen. |
| Pack is stale (old build) | Guidance continues; every recommendation surfaces `packVersion` + build date. |
| No pack for this region | The app states it has no knowledge here. It does not extrapolate. |
| No network, all session | Full function. This is the design centre, not an edge case. |
| User ignores the target | No penalty. Recommendations are advice; the traverse is the user's. |
| Field session pauses/errors | Guidance suspends and resumes with the field session. |

**No fabrication under any degraded condition.** "I don't know here" is a valid — and
sometimes the only honest — output.

---

## 4. Workflow invariants

1. **Guidance never awaits the network.** Any path where a recommendation blocks on a fetch
   is a defect, not a degradation.
2. **No unexplained recommendation.** Every target carries the reasoning that produced it.
3. **Confidence is computed, never asserted.** Unchanged from GIE Principle #4.
4. **No fabricated geology, ever** — including under degraded conditions.
5. **One sensor stack.** Exploration composes over Phase 1; it never duplicates GPS,
   heading, or session logic.
6. **Knowledge and observation stay distinguishable.** Packs are read-only; field evidence
   is an append-only overlay. Provenance survives to the conclusion.
7. **Recommendations are stable.** Re-targeting is event-driven, not fix-driven.

---

## 5. Capability map

Which workflow step needs what, and where it runs:

| Step | Capability | Offline | Cloud |
|---|---|---|---|
| 1 Start | Entitlement, sensors, pack activation | ✅ | — |
| 2 Orient | H3, local geology, occurrences | ✅ | — |
| 3 Target | Rule firing, prospectivity, scoring | ✅ | — |
| 4 Walk | GPS, heading, re-target policy | ✅ | — |
| 5 Arrive | Accuracy-aware geometry | ✅ | — |
| 6 Capture | Waypoints, photos, local store | ✅ | — |
| 7 Re-score | Evidence graph, noisy-OR | ✅ | — |
| 8 End | Traverse summary | ✅ | — |
| — | Deep image verification | | ✅ |
| — | Narrative geological interpretation | | ✅ |
| — | Dataset/pack updates, sync | | ✅ |

**Every numbered workflow step is offline.** The cloud column contains only enrichment.

---

# PART II — SUPPORTING ARCHITECTURE

## 6. Component map

Each component traced to the workflow step it serves. Anything that cannot be traced does
not belong.

| Component | Serves | Status |
|---|---|---|
| **Field Engine** (GPS, heading, session, diagnostics) | 1, 4, 8 | ✅ Phase 1, frozen |
| **Knowledge Packs** | 2, 3 | new (§7) |
| **PackGateway** | 2, 3 | new (§7.3) |
| **Providers** (7 existing) | 2, 3 | ✅ port unchanged (§7.3) |
| **Shared reasoning core** | 2, 3, 7 | extract (§8) |
| **LocalEvidenceProvider** | 6, 7 | new (§9) |
| **Waypoint store/service** | 6 | ✅ M2.1 built |
| **TargetingEngine** | 3, 7 | new — specified separately (§10.5) |
| **ExplorationOrchestrator** | all — owns the loop | new |
| **Sync + cloud verification** | cloud column | new (§10) |

### 6.1 Runtime shape

```
   ExplorationOrchestrator ── owns the state machine and the loop
        │
        ├── FieldSessionController ......... Phase 1 (frozen)
        │
        ├── GeoQuery ─┬─ PackGateway ──────► 7 providers (unchanged)
        │             └─ LocalEvidenceProvider
        │                      │
        │                      ▼
        │            fusion · confidence · priority   ◄── SHARED PURE CORE
        │                      ▼
        │                 GeoContext
        │                      ▼
        └── TargetingEngine ── scoring (noisy-OR) ──► recommendation + reason
```

---

## 7. Knowledge packs

### 7.1 Why source data, not precomputed contexts

Two pack designs were considered. **Precomputed contexts** (exporting the server's per-cell
`GeoContext`) were rejected: workflow step 7 requires re-scoring when the user's own
evidence arrives, and a context computed at build time structurally cannot incorporate
evidence that did not exist then. It could serve steps 2–3 and never 7.

A size argument also applies — Somalia is ~637,000 km², H3 res-7 cells are ~5.16 km², so
full coverage is ~123,500 cells at ~2 KB each ≈ 250 MB — but the architectural objection is
fatal on its own.

**Chosen: source-data packs + a ported deterministic core.** Under 1 MB, bundled in the
APK, and the only design where step 7 closes offline.

### 7.2 Pack format

```
pack/
  manifest.json      packId, packVersion, engineVersion, region, datasets[],
                     sha256, signature, builtAt, counts, bbox
  geology.json       Macrostrat units + polygons, H3-bucketed
  occurrences.json   MRDS occurrences, H3-bucketed
  knowledge.json     geological_knowledge statements
  rules.json         EMIE: 27 rock→commodity, 12 assemblage
  commodities.json   23 profiles (bilingual: en + so)
  associations.json  mineral_association weights
```

**Size:** ~200 KB of source SQL → well under 1 MB packed. **v1 ships inside the APK**, so
step 2 works on first launch with no download.

**H3 bucketing is an index, not a truth boundary.** Polygons and points keep their true
geometry; a radius query reads the k-ring of buckets covering the radius, then applies the
exact predicate. This preserves parity with PostGIS, which knows nothing of the H3 grid.

**Versioning — three independent axes, all already present in the schema:**

| Axis | Meaning | Exists today |
|---|---|---|
| `engineVersion` | logic version; a bump invalidates computed results | ✅ `geocontext_cache.engine_version` |
| `datasetVersion` | per-source data version | ✅ `geo.dataset_registry` |
| `packVersion` | the built artifact | new |

The app declares a supported `engineVersion` **range**. A pack outside it is **refused, not
coerced** — misinterpreting knowledge is worse than lacking it.

**Reproducibility.** Identical `geo.*` input must produce a byte-identical pack and
therefore an identical `sha256`: stable key ordering, fixed float formatting, no timestamps
inside data files. Without this, integrity verification and divergence triage both become
guesswork.

### 7.3 The port surface

Two findings from a code audit make this small.

**A. `GeoDataGateway` is already a complete, transport-agnostic interface.**
`providers/gateway.ts` defines 9 methods; every provider is built as `makeXProvider(gw)` and
receives nothing else. The file's own comment states providers depend on the interface,
"NOT on a transport". `buildProviders(gw)` structurally guarantees the gateway is a
provider's only data source.

**An offline gateway is one new implementation of an existing interface. All 7 providers
port with zero changes.**

**B. The reasoning already splits where the product needs it to.** `gie/scoring.ts` computes
confidence with no LLM call — portable as-is. `reasoning.ts` and `vision.ts` call Gemini —
correctly cloud-only.

| Gateway method | Server | Port |
|---|---|---|
| `geologyAt` | `ST_Intersects(polygon, point)` | point-in-polygon |
| `occurrencesNear` | `ST_DWithin` + `ST_Distance` | haversine + filter |
| `knowledgeNear` | `ST_DWithin` + `ST_Distance` | haversine + filter |
| `communityNear` | `ST_DWithin` aggregate | haversine + count |
| `associationsForHostRocks` | key filter | array filter |
| `knowledgeRulesFor` | key filter | array filter |
| `commodityProfiles` | key filter | array filter |
| `assemblageRulesFor` | array overlap | set intersection |
| `structuralFeaturesNear` | `ST_DWithin` (dormant — no data) | haversine + filter |

**The entire PostGIS dependency is three predicates:** `ST_Intersects`, `ST_Distance`,
`ST_DWithin`. No topology, buffers, unions, or spatial joins.

### 7.4 Known divergence — geodesy

`ST_Distance` on `geography` computes on the **WGS84 ellipsoid**; a device haversine
computes on a **sphere**. Divergence ≤ ~0.5% — ~50 m over a 10 km radius. It matters in two
specific places:

- **`proximityWeight()`** (`occurrence.ts`) uses *linear* distance falloff, so the
  difference propagates into evidence weight and therefore confidence.
- **`ST_DWithin` boundary inclusion** — an occurrence within ~50 m of the radius edge may be
  included by one implementation and excluded by the other, changing the evidence *set*,
  not merely its weights.

**Decision: accept spherical distance on device**, with a documented tolerance in the
differential suite and explicit boundary-jitter fixtures at radius ± 60 m. 0.5% is far
inside geological uncertainty; exact ellipsoidal parity (Vincenty/Karney) remains available
if shadow-mode data shows it matters.

### 7.5 Integrity and trust

1. Each pack carries a `sha256` over its data files and a signature over the manifest.
2. The bundled pack is trusted by provenance (it shipped in the signed APK).
3. A downloaded pack is verified **before activation**; failure discards it and leaves the
   previous pack active.
4. Activation is atomic: download → verify → stage → swap. Process death mid-update must
   never leave a half-installed pack.
5. Rollback to the previous pack is always available.

### 7.6 Audit confidence

Read in full: `gateway.ts`, `supabaseGateway.ts`, `providers/index.ts`, `geology.ts`,
`occurrence.ts`, `0058_geo_provider_rpcs.sql`, `h3.ts`, `cacheStore.ts`, `types.ts`,
`scoring.ts`.

Not read in full: bodies of `community.ts`, `knowledge.ts`, `mineralAssociation.ts`,
`geologicalKnowledge.ts`, `structuralGeology.ts`. Their data access is structurally
constrained by `buildProviders(gw)`, but **E0 must confirm none performs I/O outside the
gateway** before the "zero changes" claim is relied upon.

---

## 8. Shared reasoning core

**Invariant: one implementation, two runtimes.** Not "kept in sync" — one source. Two
copies drift within two sprints.

Extracted to `shared/geo-core/`: `fusion`, `confidence`, `priority`, `gie/scoring`, rule
evaluation. No `esm.sh` URLs, no `Deno.*`, no Supabase client. Deno imports it directly;
React Native consumes it via Metro.

**The EMIE cap must survive the port.** `knowledge_kb` carries weight 0.35 in its own
evidence group, so the single-group cap in `scoring.ts` means knowledge **enriches reasoning
but can never alone produce high confidence**. This is a required differential-test
assertion, not an incidental property.

---

## 9. Local evidence overlay

Two sources fuse at query time with different trust semantics:

| Source | Tiers | Mutability |
|---|---|---|
| Pack — mapped geology, occurrences, KB | `mapped`, `knowledge_kb`, … | read-only |
| Local evidence — waypoints, scans, observations | `field_observation` (0.9), `ai_visual` (0.4) | append-only |

The overlay **never mutates the pack** (Invariant 6). This is what keeps a conclusion
traceable to either published geology or the geologist's own observation.

---

## 10. Cloud responsibilities

The server remains the **authoritative source of truth** and retains exactly four jobs.

### 10.1 Pack building and dataset updates
`geo.*` → versioned, hashed, signed pack artifacts, plus a manifest endpoint the app polls.
Server providers, RPCs, schema and Edge Functions are **unchanged**.

### 10.2 Synchronisation
Session data, waypoints, tracks and evidence upload when connectivity returns. M2.1's
`syncState` and soft-delete tombstones already carry the required semantics.

### 10.3 Deep AI verification
Gemini vision verifies captured specimens. The result **upgrades the tier of an existing
evidence node** and triggers a re-score — traceable, never a silent replacement, consistent
with the existing "AI confidence never overwritten, corrections additive" rule.

### 10.4 Narrative interpretation
GIE reasoning produces the bilingual geological interpretation. Enrichment, never a
precondition for guidance.

### 10.5 TargetingEngine contract
Specified separately; it consumes this architecture. Its contract here: **given a
`GeoContext` and the current cell, rank the k-ring by prospectivity and return
`{ cell, bearing, distanceM, score, reason }`** — deterministically, offline, using the
shared core.

---

# PART III — DELIVERY

## 11. Migration stages

Stages are named by the **workflow capability they unlock**, with the supporting work
beneath.

| Stage | The user can… | Work |
|---|---|---|
| **E0** | *(nothing yet — no behaviour change)* | Extract shared core; confirm §7.6 provider I/O |
| **E1** | *(nothing yet)* | Pack format + deterministic builder |
| **E2** | **Step 2** — see what they're standing on, offline | Pack store, PackGateway, providers on device |
| **E3** | *(nothing shown)* — **shadow mode** | Device computes beside server; divergence logged |
| **E4** | **Steps 3–5** — be told where to go, and why | TargetingEngine, orchestrator, Exploration Mode UI, heading arrow |
| **E5** | **Steps 6–7** — evidence changes the recommendation | LocalEvidenceProvider, re-score, track recording |
| **E6** | **Step 8 + survive a week** | Sync, pack updates, cloud verification upgrade, export |

**E4 is the first stage where the product exists.** At its end a geologist walks into the
field with no signal and is guided. E0–E3 build the foundation and prove it correct; E5–E6
close the loop and make it durable.

**Where M2.1 lands:** into E5, unchanged. Nothing is wasted.

### 11.1 On E3 — shadow mode

The stage migrations typically skip, and the one that makes this safe. Before a
device-computed answer is ever shown to a geologist, it runs silently beside the server's
answer for the same query and **every disagreement is recorded**.

Unit tests prove the port compiles and behaves on fixtures. Only divergence data proves it
*agrees* on real ground. **E3 must not be compressed.**

**Divergence tolerance (initial):**

| Quantity | Tolerance |
|---|---|
| Distance to an occurrence | ≤ 0.5% (geodesy, §7.4) |
| Confidence score | ≤ 0.01 absolute |
| Evidence set membership | **exact** |
| Provider contribution ordering | exact |

Evidence-set membership is deliberately zero-tolerance: a differing set means the two
systems are reasoning over different worlds, which no confidence tolerance can excuse.

---

## 12. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Logic drift** between runtimes | One shared core (§8) + differential tests in CI |
| 2 | A provider performs I/O outside the gateway | E0 audit gate (§7.6) |
| 3 | **Stale packs in the field** | Every recommendation surfaces `packVersion` + build date (§3.9) |
| 4 | Silent quality regression vs cloud | E3 divergence log |
| 5 | Geodesic boundary flips | Boundary-jitter fixtures at radius ± 60 m (§7.4) |
| 6 | **Recommendation thrash** — targets changing as the user walks | Event-driven re-targeting (§3.4); stability is a tested property |
| 7 | **Trust collapse** — one absurd recommendation and the geologist stops believing the app | Invariant 2 (no unexplained recommendation) + Invariant 4 (no fabrication) |
| 8 | APK growth as datasets expand | Size budget at E1; region packs are the escape hatch (§14.2) |
| 9 | Non-deterministic builder breaks integrity | Reproducibility is an E1 exit criterion |

Risk 7 is the product risk rather than a technical one, and it is why §3.3 requires a reason
with every target.

---

## 13. Out of scope for v1

- Satellite / remote-sensing raster layers (see §14.1).
- On-device LLM reasoning. Narrative interpretation stays cloud.
- Writing geological knowledge from the device. Packs are read-only.
- The TargetingEngine's internal design — specified separately; its contract is §10.5.

---

## 14. Open decisions

### 14.1 Satellite layers — **blocking E1 scope**
The product vision lists *"satellite/geological layers already cached"* among offline
inputs, but a recorded owner constraint states **no satellite / ML / remote-sensing**, and
EMIE was built without it. `GeoContextData.remoteSensing` exists as a type with no provider;
`geo.raster_layer_registry` exists but is unused. These cannot both hold. **Owner decision
required.**

### 14.2 Pack scope — assumed, cheap to revise
**Assumption: a single Somalia-wide pack for v1.** At <1 MB, regional splitting adds
machinery for no benefit. Region packs are a later partition of the same format.

### 14.3 What counts as offline evidence — **blocking E5**
Workflow step 6 must yield a local evidence node before the cloud sees it. Either:
- **(a)** on-device classification via existing `onDeviceDetection.ts` / `gemstoneDetector.ts`
  — stronger, but their offline capability is **unassessed**; or
- **(b)** geologist-declared observations only, with cloud vision upgrading the tier later (§10.3).

**Recommendation: (b) for v1**, with (a) evaluated separately. (b) requires no unverified ML
claims, and the upgrade path means nothing is lost by starting there.

### 14.4 Enterprise subscription gating
Workflow step 1 assumes a subscription, but enterprise is currently a private beta
hard-gated to one owner email with monetization deliberately unbuilt. In Phase 2 scope, or
aspirational?

---

## 15. Summary

The architecture is the **loop**: orient → target → walk → capture → re-score → repeat,
entirely on the device.

Everything beneath it — knowledge packs, the gateway port, the shared reasoning core, the
evidence overlay, the cloud's four jobs — exists to keep that loop closed when there is no
signal.

The migration is smaller than the cloud-first framing implies, because the existing
architecture already separated data access from reasoning: `GeoDataGateway` is a clean
9-method seam, the deterministic scorer is already LLM-free, and H3 with its resolution is a
shared constant. What is genuinely new is a pack builder, a pack store, three spatial
predicates in TypeScript, a targeting engine, the orchestrator that runs the loop — and the
discipline of shadow mode.

# Offline Knowledge Packs — Architecture v1

**Status:** For review — no implementation yet
**Date:** 2026-08-03
**Scope:** Migration of LuulScan geological intelligence from cloud-first to offline-first
**Supersedes:** nothing. **Extends:** GEOCONTEXT_ENGINE_ARCHITECTURE_v1, GEOLOGICAL_INTELLIGENCE_ENGINE_v1

---

## 1. Purpose

LuulScan Enterprise Exploration must guide a geologist — possibly one with no formal
training — toward the highest-probability exploration target **while holding a phone
with no signal**. Today, 100% of the geological intelligence runs on the server.

This document specifies how the existing server-side intelligence becomes **versioned,
signed, source-data knowledge packs** consumed by the mobile app, without rewriting the
engines that produce it.

**The server remains the authoritative source of truth.** Packs are derived artifacts.
The cloud retains exactly four responsibilities: building packs, dataset updates,
synchronisation, and deep AI verification.

### 1.1 Target capability

| Capability | Offline | Requires network |
|---|---|---|
| Determine current H3 cell, local geology, occurrences | ✅ | |
| Fire exploration rules, compute confidence | ✅ | |
| Rank targets, produce bearing + reason | ✅ | |
| Record waypoints, tracks, observations | ✅ | |
| Re-score after new field evidence | ✅ | |
| Deep image verification (Gemini vision) | | ✅ |
| Narrative geological interpretation (GIE reasoning) | | ✅ |
| Dataset/pack updates, sync to server | | ✅ |

The "~95% offline" target means: **every step of the exploration loop closes without
network.** Cloud results arrive later and *improve* the model; they are never a
precondition for guidance.

---

## 2. Invariants

These hold for the life of the system. A change to any of them is a v2 decision.

1. **Packs are immutable, read-only, and never edited on device.** The server is
   authoritative. A pack is replaced wholesale by a newer version, never patched in place.
2. **Local evidence is a separate, append-only overlay.** It never mutates the pack.
   Knowledge and observation stay distinguishable at all times — this is what keeps
   provenance honest and is why a conclusion can always be traced to its source.
3. **The deterministic core has exactly one implementation**, consumed by both runtimes.
   Not "kept in sync" — one source. Two copies drift within two sprints.
4. **Guidance never awaits the network.** Any code path where a recommendation blocks on
   a fetch is a defect, not a degradation.
5. **Confidence is computed, never asserted.** Unchanged from GIE Principle #4. The
   offline path uses the same tier-weighted noisy-OR as the server.
6. **A pack that fails integrity verification is refused, not degraded.** Fabricated
   geology is the one failure mode this product cannot tolerate.

---

## 3. Current architecture (verified)

Findings below were read from the codebase, not assumed.

| Component | Location | Runtime |
|---|---|---|
| GeoContext engine, fusion, confidence, priority | `supabase/functions/_shared/geocontext/` | Deno (server) |
| 7 providers | `.../geocontext/providers/` | Deno (server) |
| GIE gather / vision / reasoning / scoring / assemble | `supabase/functions/_shared/gie/` | Deno (server) |
| MRDS (159), Macrostrat (344), EMIE rules, commodities | Postgres `geo.*` | server |
| Spatial predicates | `0058_geo_provider_rpcs.sql` | PostGIS |
| H3 on device | `h3-js` in one screen (`cellToLatLng`) | display only |
| Geological data in the app bundle | **none** | — |

**Consequence:** the app is currently ~0% offline for exploration guidance.

### 3.1 The two findings that make this migration tractable

**A. `GeoDataGateway` is already a complete, transport-agnostic data interface.**
`providers/gateway.ts` defines 9 methods; every provider is constructed as
`makeXProvider(gw)` and receives nothing else. The file's own comment states that
providers depend on the interface, "NOT on a transport". `buildProviders(gw)` therefore
structurally guarantees the gateway is a provider's only data source.

**An offline gateway is one new implementation of an existing interface.
All 7 providers port with zero changes.**

**B. The reasoning already splits where the product needs it to split.**
`gie/scoring.ts` computes confidence by deterministic tier-weighted noisy-OR with no LLM
call — portable as-is. `gie/reasoning.ts` and `gie/vision.ts` call Gemini — correctly
cloud-only. The offline/cloud boundary is a seam the architecture already has, not one
being imposed on it.

---

## 4. Target architecture

```
QUERY TIME on device:

  GeoQuery(lat, lng, h3, radiusM, sample?)
        │
        ├──► PackGateway            ─── implements GeoDataGateway
        │      reads the installed pack, read-only, versioned
        │            │
        │            └──► 7 existing providers, UNCHANGED
        │
        └──► LocalEvidenceProvider  ─── NEW provider, append-only overlay
               waypoints · scans · observations · track
        │
        ▼
   fusion · confidence · priority      ◄── SHARED PURE CORE (one implementation)
        ▼
   GeoContext  (byte-identical shape to the server's)
        ▼
   scoring.ts (noisy-OR)  ──►  TargetingEngine  ──►  recommendation + reason
```

### 4.1 Layer responsibilities

| Layer | Owns | Does not |
|---|---|---|
| **Pack store** | install, verify, activate, roll back packs | interpret geology |
| **PackGateway** | answer the 9 gateway methods from pack data | fuse or score |
| **Providers** (existing) | shape rows into contributions + evidence | know where data came from |
| **Pure core** (extracted) | fusion, priority, confidence, scoring | perform I/O |
| **TargetingEngine** (new) | rank neighbouring cells, explain why | fetch anything |
| **LocalEvidenceProvider** | expose field observations as evidence | write to the pack |

---

## 5. Port surface audit

This is the complete inventory of what must be reimplemented on device.

### 5.1 The gateway (9 methods)

| Method | Server implementation | Port |
|---|---|---|
| `geologyAt` | `ST_Intersects(polygon, point)` | point-in-polygon |
| `occurrencesNear` | `ST_DWithin` + `ST_Distance` (geography) | haversine + filter |
| `knowledgeNear` | `ST_DWithin` + `ST_Distance` (geography) | haversine + filter |
| `communityNear` | `ST_DWithin` aggregate | haversine + count |
| `associationsForHostRocks` | key filter | array filter |
| `knowledgeRulesFor` | key filter | array filter |
| `commodityProfiles` | key filter | array filter |
| `assemblageRulesFor` | array-overlap filter | set intersection |
| `structuralFeaturesNear` | `ST_DWithin` (dormant — no data loaded) | haversine + filter |

### 5.2 Spatial predicates — exactly three

The entire PostGIS dependency reduces to:

1. **`ST_Intersects(polygon, point)`** → ray-casting point-in-polygon
2. **`ST_Distance(geography, geography)`** → geodesic distance
3. **`ST_DWithin(...)`** → derived from (2)

No topology operations, no buffers, no unions, no spatial joins. All three are standard
algorithms implementable in pure TypeScript.

### 5.3 Known divergence source — geodesy

`ST_Distance` on `geography` computes on the **WGS84 ellipsoid**. A haversine
implementation computes on a **sphere**. Maximum divergence is ~0.5%; over a 10 km search
radius that is ~50 m.

This matters in two specific places:

- **`proximityWeight()`** in `occurrence.ts` uses linear distance falloff, so a distance
  difference propagates directly into evidence weight and therefore into confidence.
- **`ST_DWithin` boundary inclusion** — an occurrence sitting within ~50 m of the radius
  edge may be included by one implementation and excluded by the other, changing the
  evidence set rather than merely its weights.

**Decision: accept spherical distance on device**, with (a) a documented tolerance in the
differential test suite and (b) an explicit boundary-jitter test that places fixtures at
radius ± 60 m. 0.5% is far inside geological uncertainty; exact ellipsoidal parity
(Vincenty/Karney) is available later if shadow-mode data shows it matters.

### 5.4 Audit confidence

Read in full: `gateway.ts` (all 9 signatures), `supabaseGateway.ts`, `providers/index.ts`,
`geology.ts`, `occurrence.ts`, `0058_geo_provider_rpcs.sql`, `h3.ts`, `cacheStore.ts`,
`types.ts`, `scoring.ts`.

Not read in full: the bodies of `community.ts`, `knowledge.ts`, `mineralAssociation.ts`,
`geologicalKnowledge.ts`, `structuralGeology.ts`. Their data access is structurally
constrained by `buildProviders(gw)`, but **M0 must confirm none performs I/O outside the
gateway** before the "zero changes" claim is relied upon.

---

## 6. Pack format

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

**Size:** the source data is ~200 KB of SQL. As compact JSON, well under 1 MB. **The v1
pack ships inside the APK**, so the app is fully functional on first launch with no
download.

### 6.1 H3 bucketing

Rows are bucketed by H3 cell at `H3_RESOLUTION = 7` (~5.16 km hexagons, matching the
server constant) to bound per-query work. Bucketing is an **index, not a truth boundary**:
polygons and points keep their true geometry, and a radius query reads the k-ring of
buckets covering the radius, then applies the exact predicate. This preserves parity with
PostGIS, which has no notion of the H3 grid.

### 6.2 Versioning — three independent axes

| Axis | Meaning | Exists today |
|---|---|---|
| `engineVersion` | logic version; a bump invalidates computed results | ✅ `geocontext_cache.engine_version` |
| `datasetVersion` | per-source data version | ✅ `geo.dataset_registry` |
| `packVersion` | the built artifact | new |

The app declares a supported `engineVersion` **range**. A pack outside that range is
**refused, not coerced** — misinterpreting knowledge is worse than lacking it.

### 6.3 Reproducibility

The builder must be deterministic: identical `geo.*` input produces a byte-identical pack
and therefore an identical `sha256`. Stable key ordering, fixed float formatting, no
timestamps inside data files (only in the manifest). Without this, integrity verification
and divergence triage both become guesswork.

---

## 7. Integrity and trust

1. Every pack carries a `sha256` over its data files, and a **signature** over the manifest.
2. The bundled pack is trusted by provenance (it shipped in the signed APK).
3. A downloaded pack is verified **before activation**. Verification failure → the pack is
   discarded and the previous pack stays active.
4. Activation is atomic: download → verify → stage → swap. A process death mid-update must
   never leave a half-installed pack.
5. Rollback to the previous pack is always available.

---

## 8. Query-time composition

A device `GeoContext` is fused from two sources with different trust semantics:

| Source | Tier treatment | Mutability |
|---|---|---|
| Pack (mapped geology, occurrences, KB) | existing tiers: `mapped`, `knowledge_kb`, … | read-only |
| Local evidence (waypoint, scan, observation) | `field_observation` (0.9), `ai_visual` (0.4) | append-only |

The EMIE cap still applies: `knowledge_kb` carries weight 0.35 and its own evidence group,
so the single-group cap in `scoring.ts` means knowledge **enriches reasoning but can never
alone produce high confidence**. This property must survive the port and is a required
differential-test assertion.

### 8.1 Cloud verification upgrade path

When connectivity returns, Gemini vision may verify a locally captured specimen. The
result **upgrades the tier of an existing evidence node** and triggers a re-score. It does
not replace the local conclusion silently — the change is traceable, consistent with the
existing "AI confidence never overwritten, corrections additive" rule.

---

## 9. What changes

### 9.1 Server — additive only

1. **Extract the pure core** into `shared/geo-core/`: `fusion`, `confidence`, `priority`,
   `gie/scoring`, rule evaluation. No `esm.sh` URLs, no `Deno.*`, no Supabase client.
   Deno imports it directly; React Native consumes it via Metro.
2. **Pack builder** — exports `geo.*` → versioned, hashed, signed pack artifacts.
3. **Pack manifest endpoint** — the app polls for available versions.

Server providers, RPCs, schema and Edge Functions are **unchanged**.

### 9.2 Device — new

4. **Pack store** — bundled pack, downloads, verification, activation, rollback.
5. **PackGateway** — `GeoDataGateway` over pack data (the 9 methods, 3 predicates).
6. **LocalEvidenceProvider** — waypoints/scans/track as evidence. M2.1 already supplies
   the waypoint half, with position-copy and `syncState` semantics designed for this.
7. **H3 indexing at query time** — `h3-js` is already a dependency.

---

## 10. Migration stages

| Stage | Goal | Exit criterion |
|---|---|---|
| **M0** | Extract pure core; **zero behaviour change**. Confirm §5.4 provider I/O. | Existing Deno tests pass unchanged; core has no runtime imports |
| **M1** | Pack format + deterministic builder | Same `geo.*` input → identical `sha256` on repeat builds |
| **M2** | Device reads packs; PackGateway + providers run | App answers *"what is here?"* in airplane mode |
| **M3** | **Shadow mode** — device computes beside server, divergence logged, nothing shown | Divergence within tolerance across N real locations |
| **M4** | Cut over — offline primary, cloud enrichment | No guidance path awaits the network |
| **M5** | Update channel — signed deltas, rollback | Pack update survives process death mid-install |

### 10.1 On M3

M3 is the stage migrations typically skip, and it is the one that makes this safe.
Before a device-computed answer is ever shown to a geologist, it runs silently beside the
server's answer for the same query and **every disagreement is recorded**.

Unit tests prove the port compiles and behaves on fixtures. Only divergence data proves it
*agrees* on real ground. M3 must not be compressed.

**Divergence tolerance (initial):**

| Quantity | Tolerance |
|---|---|
| Distance to an occurrence | ≤ 0.5% (geodesy, §5.3) |
| Confidence score | ≤ 0.01 absolute |
| Evidence set membership | **exact** — any difference is a defect, not a tolerance |
| Provider contribution ordering | exact |

Evidence-set membership is deliberately zero-tolerance: a differing set means the two
systems are reasoning over different worlds, which no confidence tolerance can excuse.

---

## 11. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Logic drift** between runtimes | One shared core (Invariant 3) + differential tests in CI |
| 2 | A provider performs I/O outside the gateway | M0 audit gate before relying on "zero changes" |
| 3 | **Stale packs in the field** — a geologist runs months-old knowledge | Every recommendation surfaces `packVersion` + build date; stale guidance says so |
| 4 | Silent quality regression vs cloud | M3 divergence log is the control |
| 5 | Geodesic boundary flips (§5.3) | Boundary-jitter fixtures at radius ± 60 m |
| 6 | APK growth as datasets expand | Size budget set at M1; region packs (§13.2) are the escape hatch |
| 7 | Non-deterministic builder breaks integrity | Reproducibility is an M1 exit criterion, not a nicety |

---

## 12. Out of scope for v1

- Satellite / remote-sensing raster layers. `geo.raster_layer_registry` exists but is
  unused, and a recorded owner constraint excludes satellite/ML/remote-sensing. **See §13.1.**
- On-device LLM reasoning. Narrative interpretation stays cloud.
- Writing geological knowledge from the device. Packs are read-only (Invariant 1).
- The TargetingEngine's own design — it *consumes* this architecture and is specified
  separately.

---

## 13. Open decisions

### 13.1 Satellite layers — **blocking for M1 scope**

The product vision lists *"satellite/geological layers already cached"* among the offline
inputs, but a recorded owner constraint states **no satellite / ML / remote-sensing**, and
EMIE was deliberately built without it. `GeoContextData.remoteSensing` exists in the type
but has no provider. These cannot both hold. **Owner decision required.**

### 13.2 Pack scope — assumed, cheap to revise

**Assumption for v1: a single Somalia-wide pack.** At current data volume (<1 MB) regional
splitting adds machinery for no benefit. Region packs are a later partition of the same
format, not a redesign — deferring costs nothing.

### 13.3 What counts as offline evidence — **blocking for M2's LocalEvidenceProvider**

For the loop to close without signal, a capture must yield a local evidence node before
Gemini sees it. Two options:

- **(a)** On-device classification via the existing `onDeviceDetection.ts` /
  `gemstoneDetector.ts`. Stronger, but their offline capability is **unassessed** — this
  needs a real audit before anything is designed around it.
- **(b)** Geologist-declared observations only (waypoint type = "quartz vein"), with cloud
  vision upgrading the tier later (§8.1). Works today, and is honest about what the app knows.

**Recommendation: (b) for v1**, with (a) evaluated separately. (b) requires no new ML claims
and the upgrade path in §8.1 means nothing is lost by starting there.

### 13.4 Enterprise subscription gating

The vision's step 1 is *"user subscribes to the Enterprise plan"*, but enterprise is
currently a private beta hard-gated to one owner email, with monetization deliberately
unbuilt. Is subscription in Phase 2 scope, or aspirational for now?

---

## 14. Summary

The migration is smaller than the cloud-first framing implies, for one reason: **the
existing architecture already separated data access from reasoning.** `GeoDataGateway` is a
clean 9-method seam; the deterministic scorer is already LLM-free; H3 and its resolution
are already fixed constants shared by both sides.

What is genuinely new is a pack builder, a pack store, three spatial predicates in
TypeScript, and the discipline of shadow mode. What is explicitly *not* new is the
geology, the rules, the fusion, the confidence model, or the providers.

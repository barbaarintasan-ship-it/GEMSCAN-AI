# Luul Scan Enterprise — Phase 1 Architecture Validation Report

| | |
|---|---|
| **Type** | Production-grade engineering review (no code / no SQL / no migrations) |
| **Reviews** | Architecture v1.0 · Addendum A1 · Phase 1 Engineering Spec v1.0 |
| **Reviewer roles** | Principal PostgreSQL Architect · Supabase Enterprise Architect · PostGIS Engineer · AI Data-Infra Engineer · RN Enterprise Integration Architect |
| **Verdict** | **Conditionally ready** — sound & additive, but a small set of **Critical** items must land in the Phase-1 schema before Sprint 2. |

**Severity legend:** 🔴 **Critical** (fix before implementation) · 🟠 **Major** (fix in Phase 1 or schedule explicitly) · 🟡 **Minor** (improve soon) · ⚪ **Optional** (later).

> This is an honest self-critique. The design is fundamentally solid and cleanly isolated from the consumer app, but "production-grade" means naming the gaps now — retrofitting audit/tenant/geology structure after 1M rows is far more expensive than adding it before Sprint 2.

---

## 1. Database architecture

**Normalization:** Broadly 3NF; no harmful denormalization. Derived fields (`confidence_score`, coverage counts) are correctly kept as cached/materialized, not as sources of truth.

| # | Finding | Severity |
|---|---|---|
| 1.1 | **`verification_record` is polymorphic** (`subject_type`/`subject_id`) with **no FK** → orphan/integrity risk; RLS on it is awkward. | 🟠 Major |
| 1.2 | **No `organization`/`tenant` table** — `project.tenant_id` references nothing; tenant isolation is undefined without a tenant + membership entity. | 🔴 Critical |
| 1.3 | **`mission_assignment` and `mission_progress` are in the architecture but omitted from the Phase-1 table list** — the mission system can't assign work or show progress without them. | 🟠 Major |
| 1.4 | **No audit fields beyond `created_at`/`updated_at`** — missing `created_by`/`updated_by` and (see §9) an `audit_log`. | 🟠 Major |
| 1.5 | **No soft-delete (`deleted_at`)** on enterprise tables — hard deletes lose evidence/history. | 🟠 Major |
| 1.6 | **No score/weighting config table** — thresholds & weights are hard-coded in Edge Fns; Spec R8.1 itself flags them as "tunable via config." | 🟠 Major |
| 1.7 | **Missing CHECK constraints** — score ranges (0–100), `gps_accuracy_m >= 0`, `reputation_score` bounds, non-negative counts. | 🟡 Minor |
| 1.8 | **Child tables lack `updated_at`** (`rock_observation`, `mineral_observation`, `sample_media`) — fine if append-only, but corrections then can't be tracked. | 🟡 Minor |
| 1.9 | **All FK columns must be explicitly indexed** (Postgres doesn't auto-index FKs). Spec covers most; audit that every FK has an index (e.g., `occurrence_evidence.verified_by`, `sample.mission_id`). | 🟡 Minor |
| 1.10 | **JSONB columns** (`assay`, `indicator_flags`, `features`) need **GIN indexes** if queried by content. | 🟡 Minor |
| 1.11 | `ml.*` tables in Phase 1 are empty placeholders — harmless but could be deferred. | ⚪ Optional |

**Recommendation:** add `organization` + `organization_member` (Critical), `mission_assignment` + `mission_progress` (Major), `created_by`/`deleted_at` on core tables (Major), a `score_config` table (Major), CHECK constraints (Minor), and fix `verification_record` (see §4). No unnecessary tables were found.

---

## 2. PostGIS review

| # | Finding | Severity |
|---|---|---|
| 2.1 | **`exploration_area.boundary` typed `geography(Polygon)`** — real boundaries are frequently **MultiPolygon** (islands, disjoint outcrops). Polygon-only will reject valid geometries. Use `geography(MultiPolygon)` or generic `geometry(Geometry,4326)`. | 🟠 Major |
| 2.2 | **geography vs geometry** — `geography(4326)` is right for storage + `ST_DWithin` (meters, index-assisted). But area/length/terrain math is cheaper/accurate in a **projected geometry**; add a **generated `geometry` column** (e.g., a suitable UTM/equal-area) for analytics. | 🟠 Major |
| 2.3 | **`coverage_cell.geom` is `geometry(4326)` while locations are `geography`** — mixing types across the same workflow. Standardize (store both explicitly, or one canonical + generated). | 🟡 Minor |
| 2.4 | **H3 stored as `text`** — fine for grouping/aggregation, but **k-ring/neighbor queries can't run in-DB** without the extension. Acceptable (documented), but neighbor logic lives in app/Edge Fn. | 🟡 Minor |
| 2.5 | **Coverage aggregation via full materialized refresh** won't scale to 10M rows. Use **incremental upsert on ingest** (increment the sample's H3 cell), with periodic reconciliation. | 🟠 Major |
| 2.6 | **`ST_DWithin` dedupe of areas** is correct on geography (meters), but two concurrent offline creates can both pass (race) — see §3.2. | 🟠 Major |
| 2.7 | Spatial indexing (GIST) is specified correctly on all geo columns. | ✅ Good |

**Better alternatives:** MultiPolygon/Geometry boundaries; a projected generated column for analytics; **incremental** coverage instead of full refresh.

---

## 3. Offline architecture

| # | Finding | Severity |
|---|---|---|
| 3.1 | **Idempotent client UUID + upsert** is the correct backbone. | ✅ Good |
| 3.2 | **Duplicate-area race:** two contributors (or one, two devices) create the same place offline → different UUIDs → server dedupe by distance can still admit both if they sync near-simultaneously (dedupe check + insert not atomic). | 🟠 Major |
| 3.3 | **Duplicate-sample guard on `(collector_id, location, collected_at)`** is weak — offline **clock skew** makes `collected_at` unreliable. Rely on client UUID as the primary guard; treat spatial-temporal as advisory. | 🟠 Major |
| 3.4 | **Media-before-sample ordering:** completeness is validated at `submit-sample`, but offline the required media may upload **after** submit (or partially). Completeness must be **re-evaluated when late media arrives**, not only at submit. | 🟠 Major |
| 3.5 | **Verification recompute race:** concurrent votes recomputing `sample.status`/`confidence` need row-level locking or a serialized recompute (or the tally will race). | 🟠 Major |
| 3.6 | **Orphaned media** (sample never completes/submits) accumulate with no cleanup. | 🟡 Minor |
| 3.7 | **Retry/backoff + append-only observations** keep conflicts low; eventual consistency of derived fields is acceptable. | ✅ Good |

**Race conditions to fix:** 3.2 (atomic dedupe — advisory lock or spatial cluster constraint + reconcile), 3.4 (idempotent completeness re-check), 3.5 (locked status recompute).

---

## 4. Security review

| # | Finding | Severity |
|---|---|---|
| 4.1 | **Tenant isolation is not implementable as specified** — with no `organization`/membership table, "member of `tenant_id`" is undefined, so private-project RLS can't be written correctly. | 🔴 Critical |
| 4.2 | **Role/reputation self-escalation:** `field_contributor` allows the user to update their own row. RLS is row-level, not **column-level** — a naive policy lets a user set their own `role='admin'`/`reputation_score`. Must protect privileged columns (split table, trigger guard, or column GRANTs). | 🔴 Critical |
| 4.3 | **Authorization ≠ authentication in Edge Fns:** `verify_jwt` only proves *who*. Every function must **check the DB role** (e.g., expert-level `submit-verification`, `lab_assay` inserts) — a valid normal-user JWT must be rejected for privileged actions server-side. | 🟠 Major |
| 4.4 | **Stale JWT role claim:** if `app_role` is mirrored into the JWT, a downgraded/suspended user keeps access until token refresh (≤ 3600 s). Sensitive actions should re-check the DB, not trust the claim alone. | 🟠 Major |
| 4.5 | **`area_membership` self-insert:** if a user can insert their own membership, they join private areas at will. Must be gated to `team_leader`/`admin`. | 🟠 Major |
| 4.6 | **Community read gating:** others' samples must be invisible until `status ≥ community_confirmed`; the SELECT policy must enforce this precisely (easy to get wrong). | 🟠 Major |
| 4.7 | **Signed-URL authorization:** the URL-signing function must authorize the caller against the object's `area_id`/`tenant_id` — signing must not be a blanket capability. | 🟠 Major |
| 4.8 | **Service-role key** lives only in Edge Fns; never shipped to the client. Confirm no service key in the app bundle (consistent with existing anon-only client). | 🟠 Major |
| 4.9 | Anon fully denied (RLS on, no anon policy) is correct default-deny. | ✅ Good |

**Privilege-escalation summary:** the two 🔴 (tenant model, column-level role protection) are blockers; the 🟠 set (server-side authZ, membership gating, read gating, URL signing) must all be covered by the RLS + Edge-Fn test matrix in STEP 6.

---

## 5. Storage review

| # | Finding | Severity |
|---|---|---|
| 5.1 | **Upload through Edge Function** for quality scoring will hit **execution-time/size limits** for multi-MB images. Prefer **signed direct-to-storage upload** + **async** quality scoring, with the **on-device gate** as the primary quality filter. | 🟠 Major |
| 5.2 | **Server-side thumbnail generation** in the request path is heavy; make it an **async job** (queue/`pg_cron`/storage trigger). | 🟠 Major |
| 5.3 | **No orphaned-media retention/cleanup** policy (incomplete samples). Define TTL cleanup. | 🟠 Major |
| 5.4 | **Signed-URL fan-out** on map/list views (many thumbs) → many signing calls. Batch-sign or front with cache/CDN. | 🟡 Minor |
| 5.5 | Compression happens twice (device + server) — define **target dimensions/quality** to avoid waste. | 🟡 Minor |
| 5.6 | Private buckets + path convention (`{area_id}/{sample_id}/{role}-{media_id}`) are correct. | ✅ Good |
| 5.7 | **EXIF jsonb** may duplicate GPS/PII — fine, but flag for the privacy/retention policy. | 🟡 Minor |

---

## 6. AI data-quality review

| # | Finding | Severity |
|---|---|---|
| 6.1 | **No "absence / negative" observation type.** Prospectivity models need "surveyed here, found nothing" and **survey tracks** (where people looked). Without them the dataset is presence-only → models can't learn "not gold" and will be badly biased. | 🔴 Critical (for AI validity) |
| 6.2 | **Spatial sampling bias** — contributors cluster near roads/villages. Coverage intelligence helps, but must **actively push to gaps** and reward negative/absence sampling. | 🟠 Major |
| 6.3 | **Quality-score thresholds are undefined** — until fixed, capture/ingestion gating is inconsistent across builds/devices. | 🟠 Major |
| 6.4 | **Prolific-contributor / collector bias** — a few users dominate. Mitigate with reputation weighting **and per-contributor influence caps**. | 🟡 Minor |
| 6.5 | **Image-quality vs geology confound** — better phones → better images → model may learn image quality, not geology. Normalize/stratify. | 🟡 Minor |
| 6.6 | **Mock-location detection is not foolproof** (rooted devices) — treat as one signal, not a guarantee. | 🟡 Minor |
| 6.7 | 5-role protocol, completeness gates, trust scores, and **evidence hierarchy (only highest tier as labels)** are strong foundations. | ✅ Good |
| 6.8 | Add an optional **fiducial/ruler** to the scale-reference role for true metric calibration. | ⚪ Optional |

**Bias verdict:** the protocol produces good *per-sample* quality, but **presence-only + spatial clustering** are real dataset-level bias risks. Fixing 6.1 (absence data) is the single most important AI-readiness change.

---

## 7. Geological data review

Current observation model (`rock_observation`, `mineral_observation`) supports **basic** rock/mineral capture but is **insufficient for professional exploration targeting**.

| # | Missing capability | Severity | Recommended entity |
|---|---|---|---|
| 7.1 | **Sample method** (grab / rock-chip / channel / soil / stream-sediment) — assay interpretation depends on it | 🟠 Major | `sample.sample_method` enum |
| 7.2 | **Alteration mapping** (silicification, sericitic, argillic, propylitic; intensity) | 🟠 Major | `alteration_observation` |
| 7.3 | **Structural geology** (strike, dip, lineation, fault/fold type) | 🟠 Major | `structural_measurement` |
| 7.4 | **Economic geology** (mineralization style, sulfide %, vein density/orientation) | 🟠 Major | structured fields on `rock_observation` or `mineralization_observation` |
| 7.5 | **Lithology/formation linkage** (sample → `geological_layer`/formation) | 🟡 Minor | `sample.formation_id` (nullable FK) |
| 7.6 | **Normalized geochemistry** (per-element results vs one jsonb blob) for querying | 🟡 Minor | `lab_result_element` child (optional) |

**Recommendation:** for professional credibility, add `sample_method` (Major), `alteration_observation` and `structural_measurement` (Major) in Phase 1 or an explicit "Phase 1.5 geology" step; the rest can follow.

---

## 8. Scalability review

| Scale | Assessment | Actions |
|---|---|---|
| **100K samples** (~0.5M media) | Trivial. GIST + btree fine; single tables. | None beyond spec |
| **1M samples** (~5M media) | Comfortable with indexes + materialized coverage. | **Partition `sample_media` by month**; incremental coverage |
| **10M samples** (~50M media) | Feasible **only** with partitioning + incremental aggregates. | 🟠 **Partition `sample` & `sample_media` by time from the start**; **incremental** coverage (not full refresh); concurrent/materialized-view refresh; **read replicas** for analytics; stagger `pg_cron` |

| # | Finding | Severity |
|---|---|---|
| 8.1 | **Coverage full-refresh** is the main scaling wall — must be incremental (see 2.5). | 🟠 Major |
| 8.2 | **Storage cost dominates:** ~50M images × ~1–2 MB ≈ **50–100 TB** → tiered storage (hot thumbs / cold originals), aggressive compression, retention. | 🟠 Major (cost) |
| 8.3 | **Partition from day one** — retrofitting partitioning on a large live table is painful. | 🟠 Major |
| 8.4 | GIST on 10M points is fine; plan **VACUUM/bloat** monitoring. | 🟡 Minor |
| 8.5 | `pg_cron` job contention at scale → schedule/stagger; move heavy work off request path. | 🟡 Minor |

---

## 9. Missing enterprise features

| Capability | State | Severity | Notes |
|---|---|---|---|
| **Organization management** (tenant + members) | Missing | 🔴 Critical | Tenant isolation depends on it (§4.1) |
| **Audit logging** | Missing | 🔴 Critical | Compliance + forensics for a data platform |
| **Soft deletion** | Missing | 🟠 Major | `deleted_at` + filtered views |
| **Version history** | Missing | 🟠 Major | Who changed what (at least for area/mission/evidence) |
| **Task assignment** | Missing in Phase 1 | 🟠 Major | `mission_assignment` (in arch, dropped from Phase-1 list) |
| **Notifications** | Missing | 🟠 Major | Mission/verification/assignment events |
| **API keys** | Missing | 🟠 Major | Enterprise integrations & export automation |
| **Import / export** | Export bucket only | 🟠 Major | Need **import** for historical mining data & bulk assays |
| **Licensing** | Designed, not modeled | 🟠 Major | `data_license` records for who may use what |
| **Observability** (logs/metrics/tracing) | Missing | 🟠 Major | Edge-Fn + DB monitoring, error tracking |
| **Approval workflow** (org/contributor onboarding) | Partial (verification only) | 🟡 Minor | Reuse verification pattern |
| **Activity timeline** | Missing | 🟡 Minor | Derivable from audit_log |
| **Webhooks** (outbound) | Missing | 🟡 Minor | Later phase |
| **Search** (spatial + text) | Missing | 🟡 Minor | pg_trgm already available; add FTS |
| **Billing (enterprise seats/data)** | Consumer only | ⚪ Optional | Later phase (P7) |
| **Analytics dashboard** | Out of Phase 1 | ⚪ Optional | Later phase |

---

## 10. Phase readiness — consolidated verdict

### 🔴 Critical (must be resolved before Sprint 2 / schema freeze)
1. **Organization/tenant model** (`organization` + `organization_member`) — without it, tenant/project isolation (§4.1) cannot be implemented correctly.
2. **Column-level protection of `role`/`reputation_score`** — prevent self-escalation (§4.2).
3. **Audit logging** (`audit_log` + `created_by`) — non-negotiable for an enterprise data platform (§9).
4. **Absence/negative observation + survey track** — required for unbiased future AI (§6.1). (Schema now; capture UX later.)

### 🟠 Major (land in Phase 1 or schedule explicitly with owners)
- `mission_assignment` + `mission_progress` (§1.3); `verification_record` integrity (§1.1/§4); soft-delete (§1.5); `score_config` (§1.6); MultiPolygon/projected geometry (§2.1–2.2); incremental coverage (§2.5); offline races 3.2/3.4/3.5; server-side authZ + membership gating + URL signing (§4.3–4.7); storage upload/thumbnail/retention (§5.1–5.3); quality thresholds + sampling-bias controls (§6.2–6.3); geology entities `sample_method`/`alteration`/`structural` (§7.1–7.4); partition-from-start + storage tiering (§8.2–8.3); notifications, API keys, import, licensing, observability (§9).

### 🟡 Minor / ⚪ Optional
- CHECK constraints, GIN on JSONB, `updated_at` on child tables, H3 neighbor limitation, contributor caps, EXIF privacy, FTS/search, activity timeline, webhooks, enterprise billing/analytics (later phases).

### Readiness statement
The architecture is **structurally sound, correctly isolated from the consumer app, and ~85% implementation-ready.** It is **not yet ready to freeze the schema** until the **4 Critical items** are folded in (they are cheap now, expensive later) and the **Major** list is either implemented in Phase 1 or explicitly scheduled with owners.

**Concrete recommendation:** produce a small **"Phase 1 Schema Amendment (A2)"** that adds: `organization`/`organization_member`, `audit_log` + `created_by`/`deleted_at`, `mission_assignment`/`mission_progress`, `score_config`, absence/`survey_track` observation, `sample_method`/`alteration_observation`/`structural_measurement`, and fixes `verification_record`, boundary geometry, and the incremental-coverage strategy. Apply the 🟠 security/storage/offline fixes as **implementation requirements** (Sprint 3/5/6 acceptance criteria). Then the schema is safe to freeze and build.

---

## What comes next (pending your approval)

This review says: **address the 4 Critical items (ideally as Amendment A2), then the system is ready to implement.** On your go-ahead, the sequence is:

1. **(Recommended first)** Amendment **A2** — fold in the Critical + high-value Major schema changes (design only).
2. **Sprint 1 Implementation Plan** — day-by-day tasks.
3. **Database migrations** (starting `0018_`).
4. **RLS policies.**
5. **Edge Functions.**
6. **Offline sync engine.**
7. **React Native integration.**

**No code, SQL, or migrations were produced in this review.**

---

*End of Phase 1 Architecture Validation Report.*

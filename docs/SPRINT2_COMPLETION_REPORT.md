# Luul Scan Enterprise — Sprint 2 Completion Report

| | |
|---|---|
| **Sprint** | 2 — Database tables (`0019`–`0032`) |
| **Environment** | Local shadow DB (Docker/WSL2 · Supabase CLI 2.109.1 · PostgreSQL 17 · PostGIS 3.3.7). **Production untouched.** |
| **Status** | ✅ **COMPLETE & verified** — full chain `0001`–`0032` applies from scratch (`db reset`, exit 0). |
| **Governing docs** | Architecture v1.0 · A1 · A2 · A3 · Phase 1 Spec · ADR-0001/0002/0003 |

---

## 1. Scope delivered

14 additive, isolated, idempotent migrations building the enterprise data model.
No RLS, no Edge Functions, no app changes, no production writes, no consumer
(`public`) changes.

| # | Migration | Contents | Commit |
|---|-----------|----------|--------|
| 1 | `0019_lookup_tables` | taxonomy×4, geologic_time, deposit_model, evidence_tier, config_entry, feature_flag, sensor_type, geo.raster_layer_registry | `4f4ce46` |
| 2 | `0020_users_org` | organization, organization_member, field_contributor, project | `e7043aa` |
| 3 | `0021_geography` | geo.geological_layer, exploration_area (Point+MultiPolygon), area_membership | `bd75d26` |
| 4 | `0022_missions` | exploration_mission, mission_area, mission_contributor, mission_assignment, mission_progress | `374c65d` |
| 5 | `0023_samples` | sample, sample_location, sample_media, sample_device_context | `162c43a` |
| 6 | `0024_observations` | rock/mineral/alteration/structural observations | `9bedf9c` |
| 7 | `0025_surveys` | survey_track, field_observation_point (absence data) | `25a37f1` |
| 8 | `0026_occurrence` | occurrence_evidence, sample/occurrence_verification, lab_result | `d1a9b01` |
| 9 | `0027_custody` | sample_container, shipment, sample_chain_event, custody_signature | `6fdd1cc` |
| 10 | `0028_hooks` | coverage_cell, geo_relationship, sensor×3, conflict_log, processing_job | `8b1f551` |
| 11 | `0029_notifications` | event, notification, notification_subscription, webhook_endpoint | `80c804e` |
| 12 | `0030_audit` | audit_log (hash-chain ledger) | `f1cfbdf` |
| 13 | `0031_ml` | ml_feature, ml_model, ml_score, enterprise.data_version | `2136169` |
| 14 | `0032_triggers` | enterprise.set_updated_at() + 10 updated_at triggers | `305e299` |

## 2. Final verified state (fresh `db reset`)

| Metric | Value |
|--------|-------|
| enterprise tables | **51** |
| geo tables | **3** |
| ml tables | **3** |
| **Total new tables** | **57** |
| enterprise enum types | 22 |
| GIST indexes (enterprise+geo) | 12 |
| enterprise FK constraints | 80 |
| updated_at triggers | 10 |
| Migrations `0018`–`0032` recorded | 15 (chain clean, exit 0) |
| **`public` (consumer) base tables** | **22 — unchanged** |

## 3. Test evidence

Every migration passed the ADR-0003 cycle on the shadow DB:
**apply → VERIFY query → idempotency → rollback → re-apply**, plus functional
checks where meaningful:

- **PostGIS** — insert `geography(Point)` + `ST_DWithin` returns the row (0021).
- **CHECK** — `reputation_score=150` and out-of-range scores rejected (0020/0023).
- **Trigger** — `UPDATE` bumps `updated_at` (0032).
- **Idempotency** — every migration re-applies with exit 0 and no object churn.
- **Rollback** — every down-path returns the schema to the prior state with
  `public` and prior enterprise objects intact.
- **Full-chain** — `supabase db reset` re-applies `0001`–`0032` from scratch, exit 0.

## 4. Decisions recorded

- **ADR-0001** — Partitioning of `sample`/`sample_media` deferred (Option A);
  a pre-production recreate on the empty table will introduce it.
- **ADR-0002** — Data-preserving FK ON DELETE policy (creator refs SET NULL;
  junctions/owning-parents CASCADE).
- **ADR-0003** — Every migration ships a VERIFY query + documented rollback;
  standard idempotency/PostGIS/UUID conventions.

## 5. Constraints honored

- ✅ Production **never touched** (`db push` not run).
- ✅ Consumer schema (`public`) and app **unchanged** (22 tables throughout).
- ✅ `0018` and `0001`–`0017` **not modified**.
- ✅ Architecture design **preserved**; the one conflict found (partitioning) was
  **stopped, explained, and decided** before coding (ADR-0001).

---

## 6. "Sprint 2 → Ready for Sprint 3" checklist

| # | Gate | Status |
|---|------|--------|
| 1 | All 14 migrations written, small, independent, idempotent, rollback-documented | ✅ |
| 2 | Each migration shadow-tested (apply/verify/idempotency/rollback/re-apply) | ✅ |
| 3 | Full chain `0001`–`0032` applies from scratch (`db reset`, exit 0) | ✅ |
| 4 | Final object counts verified (57 tables, 22 enums, 12 GIST, 80 FK, 10 triggers) | ✅ |
| 5 | Consumer `public`/app proven unchanged | ✅ |
| 6 | Every migration committed to git | ✅ |
| 7 | Architecture deviations recorded as ADRs (0001–0003) | ✅ |
| 8 | Documentation updated to match implementation (this report + ADRs + A2 note) | ✅ |
| 9 | Production **not** touched | ✅ |
| 10 | Shadow DB reproducible via `supabase db start` / `db reset` | ✅ |

**Verdict: Sprint 2 is COMPLETE and the schema is ready for Sprint 3 (RLS &
Security).**

### Sprint 3 preview (not started)
RLS enable + policies on all enterprise tables (anon deny · community read-gate ·
private tenant isolation via `organization_member` · contributor scope ·
verification role-gate), **column-level protection** of `field_contributor.role`/
`reputation_score`, service-role-only writes on `sample`/`sample_media`/
`occurrence_evidence`/verifications/`audit_log`, and the STEP-6 RLS test matrix —
all per A2 §2.4 acceptance criteria, on the shadow DB, before any production apply.

---

*End of Sprint 2 Completion Report. All work verified on a local shadow database;
production was not modified.*

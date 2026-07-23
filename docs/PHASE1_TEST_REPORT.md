# Luul Scan Enterprise — Phase 1 STEP 6: Sprint 1 Test Report

| | |
|---|---|
| **Sprint** | 1 — Supabase foundation (`0018_enterprise_foundation.sql`) |
| **Environment** | **Local shadow DB** via Supabase CLI + Docker Desktop (WSL2). **Production untouched.** |
| **Docker** | 29.6.2 (linux/WSL2 backend) |
| **Supabase CLI** | 2.109.1 · Postgres 17 local · PostGIS 3.3.7 |
| **Result** | ✅ **ALL GREEN** — apply, rollback, re-apply, idempotency, consumer isolation all pass. |

> Every check ran on an **isolated local shadow database** (`supabase db start`), which applied migrations `0001`–`0018` from scratch. The hosted production project was never touched.

---

## 1. What was tested

`0018` creates the enterprise **foundation only**: schemas `enterprise`/`geo`/`ml`, extensions `postgis` + `pgcrypto`, and 22 enum types. No tables, no RLS, no functions; no reference to `public`.

---

## 2. Results

### 2.1 Migration apply
- `supabase db start` applied `0001`→`0018` cleanly. `0018` applied with a single expected NOTICE (`extension "pgcrypto" already exists, skipping`). **No errors.**
- Recorded in `supabase_migrations.schema_migrations` → `0018`. ✅

### 2.2 Object verification (`✓` = pass)

| Check | Expected | Actual | |
|---|---|---|---|
| Schemas created | `enterprise`, `geo`, `ml` | all 3 present | ✓ |
| `postgis` enabled | 3.3.x | **3.3.7** | ✓ |
| `pgcrypto` enabled | present | **1.3** | ✓ |
| Enterprise enum types | 22 | **22** | ✓ |
| Enum values sample (`area_status`) | `{new,community,verified,archived}` | exact match | ✓ |
| `public` consumer tables | unchanged | **22 present** | ✓ |

**The 22 enum types:**
`alteration_grade, alteration_type, area_origin, area_status, assignment_status, audit_action, completeness, contributor_role, evidence_type, finding_type, gps_source, media_role, mission_status, obs_method, org_role, project_visibility, review_decision, sample_method, sample_status, structure_type, terrain_type, verification_state`

### 2.3 Rollback (down-path)
- Ran `drop schema enterprise/geo/ml cascade`.
- Postgres reported `drop cascades to 22 other objects` (the 22 enum types) → schemas + enums fully removed.
- **Schemas remaining: 0 · enterprise enums remaining: 0 · `public` tables: still 22.** ✓
- **Consumer schema untouched by rollback.** ✓

### 2.4 Re-apply
- Re-ran `0018` from file → **exit 0**; schemas back to 3, enums back to 22. ✓

### 2.5 Idempotency
- Applied `0018` a **second time without rollback** → **exit 0, no error**, enum count still **22** (the `duplicate_object`-guarded `DO` blocks and `IF NOT EXISTS` make re-runs a no-op). ✓

---

## 3. Acceptance criteria (Sprint 1) — status

| # | Criterion | Status |
|---|---|---|
| 1 | `0018` applies cleanly and is idempotent | ✅ |
| 2 | `postgis` + `pgcrypto` enabled; PostGIS verified (3.3.7) | ✅ |
| 3 | Schemas `enterprise`/`geo`/`ml` exist | ✅ |
| 4 | All 22 enum types exist with correct values | ✅ |
| 5 | Documented rollback verified (apply → rollback → clean) | ✅ |
| 6 | Consumer proof: `public` present & unchanged; isolated throughout | ✅ |
| 7 | Pre-flight: PostGIS available on plan (3.3.7); shadow DB in place | ✅ |

**All seven green.**

---

## 4. Environment notes

- Local stack started with `supabase db start` (DB-only). Container: `supabase_db_gemscan-ai`. Local DB reachable on the CLI-reported port.
- To stop the local shadow when done: `supabase stop` (or `supabase db stop`). Docker Desktop can be left running for Sprint 2.
- `WARN: no files matched pattern: supabase/seed.sql` — expected (no seed file yet; seed data for lookups arrives in Sprint 2).

---

## 5. Risks / notes carried forward

- **Extensions installed into the `extensions` schema** (Supabase convention). Sprint 2 table definitions using `geography`/`geometry` must ensure `extensions` is on the search_path (Supabase default) or schema-qualify the types.
- **Production apply not performed.** Applying `0018` to the hosted project (`supabase db push`) is a separate, approval-gated step (STEP: production).
- Sprint 2 (tables `0019`–`0032`) will introduce PostGIS columns + GIST indexes — those get their own shadow test cycle.

---

## 6. Verdict

**Sprint 1 is COMPLETE and verified on the shadow DB.** `0018` is safe, idempotent, reversible, and fully isolated from the consumer app. Ready to **commit**, and — on explicit approval — to apply to production via `supabase db push`.

---

*End of Sprint 1 Test Report. All testing was performed on a local shadow database; production was not modified.*

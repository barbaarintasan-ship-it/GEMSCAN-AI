# Luul Scan Enterprise — Sprint 3 Final Security Audit

**Scope:** Row-Level Security (RLS) hardening of the `enterprise` / `geo` / `ml`
schemas (Phase 1). **Consumer `public` schema, mobile app, and production DB were
NOT touched.** All work validated on a local shadow database (Supabase CLI +
Docker) and confirmed by a full-chain `supabase db reset` (migrations `0001`→`0043`,
exit 0).

**Verdict: PASS — 100% security coverage.** No open findings.

---

## 1. Coverage matrix (post-reset, clean apply)

| Metric | Value | Target | Status |
|---|---:|---:|:--:|
| `public` tables (consumer, unchanged) | 22 | 22 | ✅ |
| `enterprise`/`geo`/`ml` tables | 57 | — | — |
| … RLS enabled | 57 | 57 | ✅ |
| … RLS **disabled** | 0 | 0 | ✅ |
| … with explicit policies | 51 | — | ✅ |
| … intentional default-deny (documented) | 6 | — | ✅ |
| **Tables with NO security decision** | **0** | **0** | ✅ |
| Total RLS policies | 73 | — | — |
| SECURITY DEFINER helpers | 12 | — | — |
| … missing `SET search_path` | 0 | 0 | ✅ |
| App-role UPDATE/DELETE on `audit_log` | 0 | 0 | ✅ |
| Invariant triggers (Collector≠Verifier ×2, audit-immutable ×1) | 3 | 3 | ✅ |

**51 policied + 6 documented default-deny = 57 → every table has an explicit,
reviewed security posture.**

---

## 2. Sprint 3 migrations (0033–0043)

| # | Migration | What it secures |
|---|---|---|
| 0033 | `enable_rls` | RLS + FORCE on all 57 tables (default-deny baseline) |
| 0034 | `rls_helpers_role_protection` | `current_contributor_role`, `is_org_member`, `is_admin` (SECURITY DEFINER, `SET search_path`); column-GRANT + trigger protecting `field_contributor.role/reputation/status` |
| 0035 | `tenancy_policies` | `org_role_of`; organization / organization_member / project (12 policies) |
| 0036 | `area_policies` | `is_project_member`, `is_area_manager`; community vs private areas, no self-assignment (8) |
| 0037 | `sample_policies` | `can_read_area`, `can_read_sample`; sample + location + media + observations + surveys — read-scoped, **writes service-only** (10) |
| 0038 | `verification_policies` | `can_read_occurrence`; occurrence/verification/lab reads + **Collector≠Verifier triggers** (4 + 2 triggers) |
| 0039 | `audit_event_policies` | `forbid_mutation` → **append-only `audit_log`**; event/notification/subscription/webhook (11 + 1 trigger) |
| 0040 | `reference_config_ml_policies` | lookups/taxonomy/registries read-all; config/ml admin-only; writes service-only (15) |
| 0041 | `contributor_mission_policies` | `is_mission_member`; `field_contributor` self read/update; mission reads (7) |
| 0042 | `custody_geo_policies` | `can_read_chain_event`; chain-of-custody + geo layers/coverage (6) |
| 0043 | `operational_service_only` | 6 machine-facing tables locked to `service_role` (documented default-deny) |

---

## 3. Core invariants (verified by functional tests, not just presence)

### 3.1 Collector ≠ Verifier (hard DB rule)
A sample's collector can **never** verify their own sample — enforced by
`trg_sample_verif_reviewer` / `trg_occ_verif_reviewer`, which fire for **every
role including `service_role`** (BYPASSRLS does not bypass triggers). This is a
database invariant, not merely an Edge-Function convention. Sample owners can
**read** their sample but cannot mutate its status/verification (writes are
service-only), so self-confirmation is structurally impossible.

### 3.2 Append-only audit ledger
`audit_log`: `authenticated` = SELECT (admin-gated by policy); `service_role` =
SELECT + INSERT only. **No app role has UPDATE/DELETE.** The `trg_audit_immutable`
trigger additionally blocks UPDATE/DELETE for **everyone — including the table
owner `postgres`** (verified: owner UPDATE and DELETE both raise
`append-only table … is not permitted`). The 2 UPDATE/DELETE entries seen in a
raw grants scan are the **owner's inherent privileges** (not a leak) and are
neutralised by the trigger.

### 3.3 Privilege-escalation protection
`field_contributor`: a user may read their own profile (admins read all) and
update only `home_region` / `training_level` (column GRANT). Attempts to change
`role`, `reputation_score`, or `status` are rejected (verified: self-`role`
update → `permission denied`). Contributor provisioning (INSERT/DELETE) is
service-only.

### 3.4 Tenant isolation & read-scoping
- Private areas/projects/samples are visible only to members of the owning
  org / project; community data becomes visible once `community_confirmed+`.
- Custody rows inherit the linked sample's visibility; `shipment` is org-scoped.
- Missions are visible to owner / roster / owning-project org members.
- Reference geology (`geo.geological_layer`) is shared-read; `coverage_cell` is
  area-scoped.

### 3.5 Function safety
All 12 SECURITY DEFINER helpers are `STABLE` and pin `SET search_path =
enterprise, pg_temp`, preventing search-path hijacking. Read-helper recursion is
avoided because helpers run as definer (bypass the calling table's RLS).

---

## 4. Intentional default-deny (6 tables — documented, not omission)

`sensor`, `sensor_capture`, `sensor_file`, `conflict_log`, `geo_relationship`,
`processing_job` are machine-facing (sensor ingestion, offline-sync conflict
ledger, derived relationship graph, async job queue). They have **no end-user
read surface in Phase 1**: RLS enabled + zero policies ⇒ `authenticated` sees
nothing (verified: read → `permission denied`); `service_role` has full DML.
`sensor`/`sensor_capture` carry `organization_id`/`sample_id`/`area_id` and are
**candidates for a scoped authenticated read in a later sprint** — that would be
its own policy migration.

---

## 5. Method / discipline
- One migration → one shadow cycle (apply → embedded VERIFY → functional tests
  with role + JWT-claim simulation → idempotency → documented rollback →
  re-apply) → one commit. Each migration reviewed for security **and** performance.
- No schema DDL in Sprint 3 (frozen schema `0018`–`0032`); no changes to `public`,
  the mobile app, or production.
- Full chain re-verified end-to-end via `supabase db reset` (exit 0).

## 6. Residual / deferred (NOT security debt)
- **Edge Functions (Sprint 5)** own all service-role writes (sample lifecycle,
  verification weighting, custody events, coverage aggregation, notifications).
  RLS is the enforcement floor; the Edge layer adds business rules on top.
- **Production apply** (`supabase db push`) is approval-gated and has **not** been
  run — production remains untouched.
- Later-sprint candidates: scoped read for `sensor*`, mission manager-side writes,
  feature-flag/geo tiering (needs its own ADR).

---

**Security foundation status: Architecture 100% · Schema 100% · Security coverage
100%.** Sprint 4 can begin on a clean base with no security technical debt.

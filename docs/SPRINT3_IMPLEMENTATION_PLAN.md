# Luul Scan Enterprise — Sprint 3 Implementation Plan (Security)

| | |
|---|---|
| **Baseline** | 🔒 [ARCHITECTURE_FREEZE_v1.md](./ARCHITECTURE_FREEZE_v1.md) — schema `0018`–`0032` frozen |
| **Sprint 3 scope** | **SECURITY ONLY** — RLS, policies, roles, grants, permissions |
| **Governing** | A2 §A2.4 (security acceptance criteria) · Phase 1 Spec Deliverable 3 · PHASE1_ARCHITECTURE_VALIDATION §4 |
| **Status** | **Plan for review.** No migrations / SQL / code produced. Sprint 3 begins only on the explicit command "Sprint 3 bilow". |

> Per Freeze rule #2, Sprint 3 **may not redesign the schema** — no new
> tables/columns/relationships, no structural DDL. It adds RLS policies,
> column-level GRANTs, RLS-support helper functions, and (documented) roles.

---

## 1. Objective

Make every enterprise surface safe: anonymous denied, normal users see only
community-level data, contributors see their own + confirmed data, private
project data is tenant-isolated, privileged actions are role-gated, and no user
can escalate their own role — all enforced at the database layer as the backstop,
with **all enterprise writes flowing through Edge Functions** (Sprint 4).

---

## 2. What Sprint 3 delivers

1. **RLS enabled + default-deny** on every table in `enterprise`, `geo`, `ml`.
2. **RLS-support helper functions** (read-only, `security definer` where needed):
   e.g. "is the caller a member of org X", "caller's contributor role",
   "is area A community/public". (Functions, not schema changes.)
3. **Policies** per surface (§4).
4. **Column-level protection** of `field_contributor.role` / `reputation_score` /
   `status` (GRANT UPDATE only on safe columns; a `BEFORE UPDATE` guard trigger as
   backstop) — resolves the self-escalation Critical (validation §4.2).
5. **Service-role-only writes** on `sample`, `sample_media`, `occurrence_evidence`,
   `sample_verification`, `occurrence_verification`, `audit_log` (no client INSERT).
6. **Audit-log immutability** (no UPDATE/DELETE policy for anyone; append-only).
7. **RLS test matrix** (§6) proving isolation, on the shadow DB.

**Explicitly NOT in Sprint 3:** Edge Functions (Sprint 5), Storage buckets/policies
(Sprint 4), app code, production apply, any schema/DDL change.

---

## 3. Migration order (RLS-only, `0033`+)

Each small, independent, idempotent, rollback-documented, VERIFY-carrying
(per ADR-0003). Illustrative grouping (final split confirmed at build time):

| Migration | Focus |
|-----------|-------|
| `0033` | Enable RLS + default-deny on all enterprise/geo/ml tables |
| `0034` | RLS-support helper functions + column-level GRANTs & role-guard trigger (role protection) |
| `0035` | Policies: organization, organization_member, project (tenancy) |
| `0036` | Policies: exploration_area, area_membership (community vs private read/write) |
| `0037` | Policies: sample + location/media/device_context/observations/surveys (contributor scope, community read-gate, service-role writes) |
| `0038` | Policies: occurrence_evidence, sample/occurrence_verification, lab_result (role-gated; expert/lab tiers) |
| `0039` | Policies: audit_log (append-only), event/notification/subscription/webhook |
| `0040` | Policies: lookups/config/feature_flag/registries/ml (read rules + admin/service writes) |

Rollback per migration = disable the policies/RLS it added (documented down-path);
never alters table structure.

---

## 4. RLS design per surface

| Surface | Read | Write |
|---|---|---|
| **Lookups / taxonomy / geologic_time / deposit_model / evidence_tier / feature_flag** | authenticated | admin / service only |
| **config_entry** | admin (+ own-tenant overrides) | admin / service |
| **organization / project** | members of the org (via `organization_member`) | owner/admin; `public` projects readable by authenticated |
| **organization_member / area_membership** | members | managed by owner/team_leader/admin — **no self-insert** |
| **field_contributor** | own row (+ admin) | own **non-privileged** columns only; role/reputation/status = service only (§2.4) |
| **exploration_area (community, `project_id` null)** | authenticated | insert: authenticated; update: creator/team_leader/admin |
| **exploration_area (private, project)** | org members only | org members ≥ contributor |
| **sample + children / observations / surveys** | own always; others only when `status ≥ community_confirmed` (community) or same tenant (private) | **service role only** (via Edge Fn) |
| **occurrence_evidence / verifications / lab_result** | scoped as above | insert: service role; expert-level / lab_assay / drill = expert/admin/accredited only |
| **audit_log** | admin / service | **append-only; no update/delete for anyone** |
| **event / notification** | own notifications; org events for members | service role |
| **geo (coverage_cell, geological_layer, raster_registry)** | read follows area/authenticated | admin / service |
| **ml (feature/model/score)** | read follows entity; scores read-only | service only |
| **Anonymous** | **denied everywhere** (default-deny, no anon policy) | denied |

Tenant predicate (from A2.2.1): a row is visible iff
`EXISTS (organization_member where organization_id = <row org> and user_id = auth.uid())`.

---

## 5. Workflow (per migration, on shadow DB)

Same discipline as Sprint 1/2 (ADR-0003):
`apply → VERIFY query → idempotency → rollback → re-apply`, plus **functional RLS
tests** using role impersonation (`set role` / JWT-claim simulation) to assert
each cell of the test matrix. Consumer `public` isolation asserted every cycle.

Rollback for RLS = drop the added policies and (where applicable) `disable row
level security`; structure is never touched.

---

## 6. RLS test matrix (STEP 6 acceptance — A2 §2.4)

Prove, on the shadow DB, for representative tables:

| Actor | Expectation |
|-------|-------------|
| **anon** | denied on every enterprise/geo/ml table (read + write) |
| **normal authenticated** | community-area + confirmed data only; no private data; cannot write sample/evidence directly |
| **field_contributor** | own samples always; others only when confirmed; still no direct writes (service-only) |
| **org member** | own tenant's private project/area data; nothing cross-tenant |
| **cross-tenant user** | denied on another org's private data |
| **self-escalation attempt** | `update field_contributor set role='admin'` → **rejected** (column GRANT + trigger) |
| **expert-only action** | non-expert inserting expert verification / lab_result → **rejected** |
| **audit tamper** | update/delete on `audit_log` → **rejected** (append-only) |

All eight must pass before Sprint 3 is accepted.

---

## 7. Acceptance criteria

| # | Criterion | Source |
|---|-----------|--------|
| 1 | RLS enabled + default-deny on all enterprise/geo/ml tables | §2.1 |
| 2 | Role/reputation self-escalation impossible (column GRANT + trigger) | validation §4.2 |
| 3 | Tenant isolation enforced via `organization_member` predicate | A2.2.1 |
| 4 | Community read-gate (`status ≥ community_confirmed`) enforced | validation §4.6 |
| 5 | Direct client writes disabled on sample/media/occurrence/verifications/audit | §2.5 |
| 6 | audit_log append-only (no update/delete) | A3.1.5 |
| 7 | Full RLS test matrix (§6) green on shadow DB | STEP 6 |
| 8 | Consumer `public` unchanged; no schema/DDL change (freeze respected) | Freeze rule #2 |
| 9 | Each migration idempotent, rollback-documented, VERIFY-carrying | ADR-0003 |
| 10 | Production not touched | Freeze rule #3 |

---

## 8. Sprint 3 may NOT (hard boundary)

- ❌ create/alter/drop any table, column, type, constraint, index, or FK
- ❌ redesign relationships or add new entities
- ❌ modify migrations `0018`–`0032`
- ❌ touch `public` / consumer app
- ❌ `supabase db push` to production
- ❌ build Edge Functions, Storage, or app code (later sprints)

Any need for a schema change → **stop, write a new ADR, get approval** (Freeze rule #1).

---

## 9. Next step

This plan is for review. On the explicit command **"Sprint 3 bilow"**, Sprint 3
begins with `0033` (enable RLS + default-deny), each step shadow-tested and
committed exactly as in Sprint 2.

*Plan only — no migrations, SQL, or code produced.*

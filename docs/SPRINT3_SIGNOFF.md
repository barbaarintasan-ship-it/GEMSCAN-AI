# Luul Scan Enterprise — Sprint 3 Sign-off

**Sprint:** 3 — Row-Level Security hardening (`enterprise` / `geo` / `ml`)
**Status:** ✅ **CLOSED**
**Tag:** `v1.0-security-complete`
**Migrations:** `0033` → `0043` (11)
**Consumer `public` / mobile app / production:** untouched

---

## Sign-off checklist

| # | Gate | Status | Evidence |
|---|---|:--:|---|
| 1 | Architecture approved | ✅ | Architecture Freeze v1.0 (`ARCHITECTURE_FREEZE_v1.md`, tag `enterprise-architecture-v1.0`) |
| 2 | Schema approved | ✅ | Frozen `0018`–`0032`; 57 tables (enterprise 51 / geo 3 / ml 3), 22 enums, 80 FKs, 12 GIST, 10 updated_at triggers |
| 3 | Security approved | ✅ | `SPRINT3_FINAL_SECURITY_AUDIT.md` — 100% coverage, PASS, no open findings |
| 4 | Full-chain reset passed | ✅ | `supabase db reset` migrations `0001`→`0043`, exit 0 |
| 5 | Performance review passed | ✅ | All RLS predicate columns index-backed (leading index); helpers STABLE + `SET search_path`; no hot-path seq scans (see §Performance) |
| 6 | No known blockers | ✅ | None open; residual items are deferred future-sprint work, not debt (see §Residual) |
| 7 | Sprint 3 officially closed | ✅ | This sign-off + annotated tag `v1.0-security-complete` |

---

## Security posture (recap)

- **57 tables** → 51 policied + 6 documented default-deny = **100% explicit coverage** (0 undecided).
- **73 RLS policies**; **12 SECURITY DEFINER helpers**, all `STABLE` with `SET search_path` (0 unsafe).
- **Collector ≠ Verifier** enforced by triggers for **all roles** (incl. `service_role`).
- **`audit_log` append-only** — UPDATE/DELETE blocked for everyone incl. table owner; no app-role UPDATE/DELETE grants.
- **Privilege escalation blocked** — `field_contributor.role/reputation/status` immutable by self.
- Tenant isolation, community-vs-private gating, custody-follows-sample, mission-member scoping all functionally verified.

## Performance

Every column referenced in an RLS predicate or helper (`organization_member.user_id`,
`mission_contributor.contributor_id`, `sample.collector_id/area_id/status`,
`exploration_area.project_id`, `sample_chain_event.sample_id`,
`occurrence_evidence.*`, `field_contributor.user_id`, `notification.user_id`,
`coverage_cell.area_id`, …) is backed by a **leading index**. Helper functions are
`STABLE` so their results are cached within a statement, and `SECURITY DEFINER` so
they resolve membership without triggering nested RLS. **Follow-up:** re-run
`EXPLAIN ANALYZE` on representative queries once production-scale data exists (the
planner may prefer seq scans on tiny tables regardless of indexes).

## Residual / deferred (NOT security debt)

- **Production apply** (`supabase db push`) — approval-gated, **not run**; production untouched.
- Service-role writes are owned by **Edge Functions (Sprint 4/5)** — RLS is the enforcement floor.
- Future-sprint candidates: scoped authenticated read for `sensor*`, mission
  manager-side writes, feature-flag/geo tiering (own ADR).

---

## Transition to Sprint 4 — cadence change

The database foundation is **settled**, so Sprint 4 switches from
**Migration → Review** to **Feature → Review**. Planned features, each building
directly on the completed security foundation:

1. Edge Functions (service-role write layer)
2. Authentication middleware
3. Sample submission API
4. Verification API (Collector ≠ Verifier already DB-enforced)
5. Community Intelligence ingestion pipeline
6. AI Geological Engine (entry point)

**Sprint 3 is officially closed. Sprint 4 may begin.**

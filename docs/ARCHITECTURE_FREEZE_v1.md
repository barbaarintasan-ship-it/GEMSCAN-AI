# Luul Scan Enterprise — ARCHITECTURE FREEZE v1.0

> **This document is a CONTRACT, not a design.** It freezes the enterprise data
> architecture and schema as implemented through Sprint 2. It is the boundary
> between **Schema Design (complete)** and **Security Implementation (Sprint 3+,
> not started)**. It does not redesign anything.

| | |
|---|---|
| **Architecture version** | v1.0 (+ Addendum A1, Amendment A2, Amendment A3) |
| **Freeze date** | 2026-07-23 |
| **Scope frozen** | Enterprise data schema — migrations `0018`–`0032` |
| **Consumer app** | Untouched and out of scope of this freeze |
| **Status** | 🔒 **FROZEN** |

---

## 1. Frozen git references

| Ref | Commit | Meaning |
|-----|--------|---------|
| Baseline / design suite | `368ae00` | Docs, build config, Play assets baseline |
| Architecture-freeze tag | `enterprise-architecture-v1.0` | Design-complete tag (pre-implementation) |
| Sprint 1 foundation (0018) | `733aa3e` | schemas + extensions + 22 enums |
| Sprint 2 docs + ADRs | `3259729` | completion report + ADR-0001/0002/0003 |

### Sprint 2 migration commits (`0019`–`0032`)
| Migration | Commit |
|-----------|--------|
| 0019 lookup_tables | `4f4ce46` |
| 0020 users_org | `e7043aa` |
| 0021 geography | `bd75d26` |
| 0022 missions | `374c65d` |
| 0023 samples | `162c43a` |
| 0024 observations | `9bedf9c` |
| 0025 surveys | `25a37f1` |
| 0026 occurrence | `d1a9b01` |
| 0027 custody | `6fdd1cc` |
| 0028 hooks | `8b1f551` |
| 0029 notifications | `80c804e` |
| 0030 audit | `f1cfbdf` |
| 0031 ml | `2136169` |
| 0032 triggers | `305e299` |

---

## 2. Frozen migrations (`0018`–`0032`)

`0018_enterprise_foundation` · `0019_lookup_tables` · `0020_users_org` ·
`0021_geography` · `0022_missions` · `0023_samples` · `0024_observations` ·
`0025_surveys` · `0026_occurrence` · `0027_custody` · `0028_hooks` ·
`0029_notifications` · `0030_audit` · `0031_ml` · `0032_triggers`

Verified: full chain `0001`–`0032` applies from scratch on the local shadow DB
(`supabase db reset`, exit 0). **Production not applied** (approval-gated).

---

## 3. Approved decisions (ADRs)

| ADR | Decision | File |
|-----|----------|------|
| **ADR-0001** | `sample`/`sample_media` **partitioning DEFERRED** to a pre-production recreate on the empty table (keeps clean single-column `sample_id` FKs) | [adr/ADR-0001-partitioning-deferred.md](./adr/ADR-0001-partitioning-deferred.md) |
| **ADR-0002** | **FK ON DELETE policy** — data-preserving: creator/owner refs `SET NULL`; membership/owning-parent `CASCADE` | [adr/ADR-0002-fk-on-delete-policy.md](./adr/ADR-0002-fk-on-delete-policy.md) |
| **ADR-0003** | **Migration VERIFY-query standard** + idempotency / PostGIS / UUID conventions | [adr/ADR-0003-migration-verify-standard.md](./adr/ADR-0003-migration-verify-standard.md) |

---

## 4. Official documentation set (source of truth)

| Document | Role |
|----------|------|
| [LuulScan-Enterprise-Architecture-v1.md](./LuulScan-Enterprise-Architecture-v1.md) | Master architecture |
| [LuulScan-Enterprise-Architecture-v1-Addendum.md](./LuulScan-Enterprise-Architecture-v1-Addendum.md) | Addendum A1 |
| [LuulScan-Enterprise-Architecture-A2-Schema-Amendment.md](./LuulScan-Enterprise-Architecture-A2-Schema-Amendment.md) | Amendment A2 (critical fixes) |
| [LuulScan-Enterprise-Architecture-A3-Advanced-Extensions.md](./LuulScan-Enterprise-Architecture-A3-Advanced-Extensions.md) | Amendment A3 (extensions/hooks) |
| [LuulScan-Enterprise-Phase1-Engineering-Spec-v1.md](./LuulScan-Enterprise-Phase1-Engineering-Spec-v1.md) | Phase 1 engineering spec |
| [PHASE1_AUDIT_REPORT.md](./PHASE1_AUDIT_REPORT.md) | STEP 0 repository audit |
| [PHASE1_ARCHITECTURE_VALIDATION.md](./PHASE1_ARCHITECTURE_VALIDATION.md) | Architecture validation |
| [PHASE1_TEST_REPORT.md](./PHASE1_TEST_REPORT.md) | Sprint 1 test report |
| [SPRINT1_IMPLEMENTATION_PLAN.md](./SPRINT1_IMPLEMENTATION_PLAN.md) | Sprint 1 plan |
| [SPRINT2_COMPLETION_REPORT.md](./SPRINT2_COMPLETION_REPORT.md) | Sprint 2 completion |
| [adr/ADR-0001…0003](./adr/) | Decision records |
| **ARCHITECTURE_FREEZE_v1.md** (this) | The freeze contract |

---

## 5. Sprint 2 final metrics (frozen)

| Metric | Value |
|--------|-------|
| enterprise tables | 51 |
| geo tables | 3 |
| ml tables | 3 |
| **total new tables** | **57** |
| enterprise enum types | 22 |
| enterprise FK constraints | 80 |
| GIST indexes (enterprise + geo) | 12 |
| `updated_at` triggers | 10 |
| migrations `0018`–`0032` | 15 |
| consumer `public` base tables | 22 (unchanged) |

---

## 6. Freeze rules (binding)

1. 🔒 **No schema changes without a new ADR.** Any new table, column, type,
   constraint, index, or FK — or any change to an existing one — REQUIRES a new
   ADR (ADR-0004+) approved before implementation. Migrations `0018`–`0032` are
   immutable; changes come as **new** migrations.

2. 🔒 **Sprint 3 may implement SECURITY ONLY** — Row Level Security, policies,
   roles, grants, and permissions. **It may NOT redesign the schema** (no new
   tables/columns/relationships; no altering table structure). Column-level
   privilege GRANTs and RLS policies are permitted; structural DDL is not.

3. 🔒 **Production is not touched** by this freeze. Applying `0018`–`0032` (or any
   later migration) to the hosted project via `supabase db push` remains a
   separate, explicitly approval-gated step.

4. 🔒 **Consumer app / `public` schema stay out of scope** — never modified by
   enterprise work.

5. 🔒 **The official documentation set (§4) is the single source of truth.** Code
   must conform to it; divergence requires an ADR, not a silent edit.

---

## 7. What is NOT frozen (future, needs its own gate)

- Security implementation (Sprint 3 — RLS/policies/roles) — planned, not built.
- Edge Functions, Storage buckets, offline sync, RN integration (Sprints 4–7).
- Production apply (`db push`).
- Deferred items with hooks: partitioning (ADR-0001), AI dataset/model machinery
  (Phase 6), raster ingestion (Phase 4), international-standards export (Phase 7).

---

## 8. Freeze declaration

The Luul Scan Enterprise **data schema (migrations `0018`–`0032`) is FROZEN at
v1.0** as of 2026-07-23. It is complete, shadow-verified, documented, and governed
by ADRs 0001–0003. Further work proceeds **on top of** this frozen schema —
security first (Sprint 3) — and **never redesigns it** without a new, approved ADR.

*This is a contract. It records the frozen state; it does not design anything new.*

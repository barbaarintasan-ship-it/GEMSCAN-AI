# Luul Scan Enterprise — Engineering Status Report
*Generated 2026-07-27 · strictly from the current repository (migrations 0001–0058, code, tests, docs). No plans/assumptions counted as done.*

---

## 1. Executive Summary
- **Overall enterprise-project completion: ~38%.** The **foundation is essentially finished; the operating platform is barely started.**
- **Maturity:** Foundation-complete. Database + security = production-grade and frozen; runtime services = 2 of ~10 Edge Functions; no data loaded; nothing deployed to production.
- **Could it operate today?** The **consumer app operates today** (scanning, valuation, website-based payments — pre-existing product on `main`). The **Enterprise platform cannot serve real users today**: only a status endpoint (`enterprise-context`) and the GeoContext engine exist as runtime; no sample/verification/mission/provisioning APIs; no enterprise mobile UI; no reference data loaded; not deployed.
- **Biggest strengths:** (1) a comprehensive, RLS-hardened, frozen data model (69 tables, 84 policies, 100% RLS coverage, invariant triggers); (2) a clean, tested runtime spine (auth/authz middleware + GeoContext engine with E2E tests); (3) exceptional documentation & governance discipline (ADRs, sprint sign-offs, corpus registry).
- **Biggest missing components:** enterprise write APIs (sample submission, verification, custody, missions, provisioning); the Knowledge Extraction Pipeline + data loading (reference/ontology/GIS/occurrence tables are empty); the AI Geological Reasoning Engine; enterprise mobile integration; production deployment.

## 2. Architecture Status
| Subsystem | Planned | Implemented | Tested | Prod-Ready | Remaining |
|---|:--:|:--:|:--:|:--:|---|
| Enterprise architecture (schema/design) | ✅ | ✅ | ✅ (shadow) | ✅ (frozen v1.0) | Post-freeze extensions only |
| Database | ✅ | ✅ (0018–0058) | ✅ shadow + full reset | ⚠️ not applied to prod | `supabase db push` (gated) |
| Authentication | ✅ | ✅ `resolveActor` | ✅ unit | ⚠️ not deployed | deploy; wire more fns |
| Authorization | ✅ | ✅ RLS + authz middleware | ✅ unit + SQL | ⚠️ not deployed | per-action guards in real fns |
| Edge Functions | ✅ | ⚠️ 2/~10 enterprise | ✅ those 2 | ❌ | 6–8 enterprise APIs |
| AI (geological) | ✅ | ⚠️ GeoContext input only | ✅ engine/E2E | ❌ | reasoning engine; data; deploy |
| Mobile integration | ✅ | ❌ none (consumer only) | — | ❌ | all enterprise screens |
| Community Intelligence | ✅ | ⚠️ schema + provider only | ⚠️ provider unit | ❌ | ingestion pipeline |
| Geological Intelligence | ✅ | ⚠️ engine + providers | ✅ E2E | ❌ | data load; deploy |
| Administration | ✅ | ⚠️ owner-gate only | ✅ unit | ❌ | provisioning/admin tools |
| Notifications | ✅ | ⚠️ schema only | ❌ | ❌ | dispatch/webhook runtime |
| Background jobs | ✅ | ⚠️ schema (`processing_job`) only | ❌ | ❌ | worker/queue runtime |

## 3. Database Status *(verified on shadow DB, all 58 migrations applied)*
- **Schemas:** `public` (consumer, 22 tables, unchanged), `enterprise` (51), `geo` (15), `ml` (3).
- **Tables:** 91 total (69 in enterprise/geo/ml).
- **Migrations:** 58 (`0001`–`0058`); enterprise/geo = `0018`–`0058`. Full-chain `db reset` green.
- **Triggers:** 27 (updated_at set, Collector≠Verifier ×2, append-only audit, role-protection, ontology `*_key→*_id` auto-resolve).
- **Views:** 0.
- **Functions:** 22 (18 SECURITY DEFINER helpers, all `SET search_path`) — RLS helpers (`is_org_member`, `is_project_member`, `is_mission_member`, `can_read_*`, `org_role_of`, …) + 5 GeoContext spatial RPCs.
- **RLS coverage:** **100%** — 69/69 enterprise/geo/ml tables RLS-enabled; **84 policies**; 6 machine-facing tables intentional default-deny.
- **Security helpers:** complete (Sprint 3 audit PASS).
- **Complete:** schema, enums (22), FKs, indexes (GIST/GIN), RLS, triggers, helpers, GeoContext P0 tables.
- **Missing:** production apply; **all reference/ontology/GIS/occurrence tables are EMPTY** (no data loaded); optional partitioning deferred (ADR-0001).

## 4. API / Edge Functions Status
**21 functions total** — 19 pre-existing consumer/payment, **2 enterprise**.
**Enterprise:**
| Function | Purpose | AuthN | AuthZ | Prod-ready | Missing |
|---|---|---|---|:--:|---|
| `enterprise-context` | who-am-I / entitlement status | JWT (verify_jwt) | `isEnterpriseEnabled` (owner/active-org) | ⚠️ not deployed | — |
| `geocontext` | GeoContext runtime → JSON | JWT | `requireEnterprise` | ⚠️ not deployed | needs seeded data + prod schema exposure |

**Consumer/payment (pre-existing, operational on `main`):** orchestrate-scan, precheck-object, estimate-value, verify-subscription, activate-subscription, create-checkout-session, stripe/mobile-money/high-value/gold/artifact webhooks, verify-gold/artifact/high-value, gemscan-analytics/users, delete-account/scan, diag-gemini.

**Enterprise APIs still to build:** sample-submission · verification-submit · custody-event · mission-management · provision-organization · notification-dispatch · processing-job worker · community-ingestion · (knowledge-extraction is offline, not an Edge Fn).

## 5. Authentication & Authorization
- **Implemented:** `_shared/enterprise/` middleware — `resolveActor` (JWT→identity), `authz` (owner gate = reused `isOwnerEmail`, `requireEnterprise/requireRole/requireAdmin`), lazy `context` (org/project/mission membership), `clients` (service/user), typed `errors`. Unit-tested (7) + used by `enterprise-context` (5 tests) + validated against shadow DB.
- **JWT flow:** platform `verify_jwt=true` → `resolveActor` re-verifies via `getUser()` → contributor role from `field_contributor` (service client). Two auth models coexist (user-JWT vs shared-secret service-to-service, e.g. `activate-subscription`).
- **Service role:** used for enterprise writes (RLS = service-only) + entitlement checks; DB triggers are the invariant floor even for service role.
- **RLS:** 100% coverage; default-deny; Collector≠Verifier + append-only audit enforced by triggers.
- **Remaining middleware:** per-action guards inside the not-yet-built write APIs; org provisioning path.
- **Security risks remaining:** none structural in the DB layer (Sprint 3 PASS). Operational: config.toml (schema exposure) uncommitted + entangled with payment edits; production "Exposed schemas" not set; private-beta gate relies on `OWNER_EMAILS` (intentional).

## 6. AI Pipeline Status
- **Implemented:** consumer scan pipeline (`orchestrate-scan` 3-AI ensemble, `precheck-object`, `estimate-value`) — image analysis, gem identification, valuation (pre-existing product). GeoContext **input** layer: engine + fusion + confidence + 5 providers + cache, E2E-tested.
- **Prototype:** GeoContext runtime (built/tested but not deployed, no data loaded).
- **Planned (not started):** AI Geological **Reasoning** Engine (consumes GeoContext JSON); Community-Intelligence aggregation/clustering; prospect-prediction/ML scoring (`ml.*` tables are placeholders).

## 7. Mobile Application Status
- **Existing (consumer app, shipping):** `(auth)` login/register; `(app)` home, `scan/` (capture, results, batch, verify, verify-gold, verify-artifact), account, settings; Gold Prospect Evaluation; website-payment CTAs; PDF reports.
- **Completed features:** scanning/identification, valuation, My Collection, gold-prospect, subscription/entitlement display.
- **Broken/incomplete:** none enterprise (n/a).
- **Enterprise integration:** **0%** — no enterprise screens, no calls to `enterprise-context`/`geocontext`, no org/mission/sample UI.

## 8. Missing Components (checklist)
**Critical**
- Enterprise write APIs (sample/verification/custody/mission) — **Not started**
- Data loading into geo/reference/ontology tables (tables empty) — **Not started**
- Production deployment (`db push`, schema exposure, function deploy) — **Not started**
- AI Geological Reasoning Engine — **Not started**

**High**
- Knowledge Extraction Pipeline (P2) — **Not started** (corpus collection in progress)
- `provision-organization` + admin/monetization path — **Not started**
- Enterprise mobile integration — **Not started**
- GeoContext deployment + seeded reference data — **Partially** (engine done; data/deploy pending)

**Medium**
- Notification dispatch runtime — **Not started** (schema done)
- Background-job worker (`processing_job`) — **Not started** (schema done)
- Community-Intelligence ingestion — **Not started** (schema + read provider done)
- Portal-resolver adapters (OneGeology/BRGM/Smithsonian) — **Not started**

**Low**
- GDAL/OGR deep geo validation in extraction env — **Not started**
- config.toml clean commit (de-entangle) — **Partially**
- Corpus binaries git-hygiene (.gitignore) — **Not started**

## 9. Sprint Status
| Sprint | Objective | Deliverables | % |
|---|---|---|---:|
| Phase 1 arch | Enterprise architecture + validation | Arch v1/A2/A3, Phase1 spec, audits, freeze v1.0 | 100% |
| Sprint 1 | Foundation migration | 0018 (schemas/extensions/enums) | 100% |
| Sprint 2 | Core schema | 0019–0032 (51 tables, FKs, triggers) + ADRs | 100% |
| Sprint 3 | Security/RLS | 0033–0043 (RLS 100%, helpers, invariants) + audit PASS + sign-off | 100% |
| Sprint 4.1 | Backend foundation | auth/authz middleware + `enterprise-context` | 100% |
| GeoContext P0 | Schema | 0044–0058 (12 geo tables + ontology + RPCs) | 100% |
| GeoContext P1 | Runtime engine | engine/fusion/confidence/providers + `geocontext` fn + E2E | ~90% (built/tested; not deployed/data-loaded) |
| GeoContext P2 | Corpus | registry (frozen v1.2, 74 records), execution plan, pilot, safeguards, Batch 1–2 + manual ingests (16 collected) | ~35% (discovery+governance done; collection ongoing; extraction not started) |

**Recommended next sprint:** **Sprint 4.2 — Sample Submission API** (first enterprise write path: `resolveActor`→`requireEnterprise`→validate→service-role insert→audit), the unblocker for verification/community.

## 10. Current Critical Path (to a real-user Enterprise platform)
1. **Deploy the foundation** (`db push` + exposed schemas + deploy `enterprise-context`/`geocontext`). *Nothing runs against prod until this exists.*
2. **Provisioning** (`provision-organization` + owner allowlist) — *so a real org/user can be entitled; every enterprise action gates on org-active.*
3. **Sample Submission API** — *the first data-producing workflow; everything downstream needs samples.*
4. **Verification API** — *depends on samples; Collector≠Verifier already enforced in DB.*
5. **Community-Intelligence ingestion** — *aggregates verified samples; needs 3–4.*
6. **Load reference/ontology/GIS/occurrence data** (+ Knowledge Extraction Pipeline) — *GeoContext providers return empty until the tables are populated.*
7. **Deploy GeoContext + AI Geological Reasoning Engine** — *reasoning consumes GeoContext JSON, which needs data (6) and a deployed engine.*
8. **Enterprise mobile integration** — *surfaces 3–7 to users; last because it consumes the APIs.*
Each step is a hard dependency for the next (deploy → entitle → produce data → verify → aggregate → contextualize → reason → surface).

## 11. Estimated Remaining Work
| Dimension | Complete | Basis |
|---|---:|---|
| Backend (DB/schema/security) | **~92%** | 58 migrations, 100% RLS, frozen + audited; missing only prod apply + ops |
| Enterprise (as a platform) | **~30%** | schema 100%, but 2/~10 runtime APIs, no provisioning, no data, no mobile |
| Mobile | **~50% overall / 0% enterprise** | consumer app shipping; enterprise UI not started |
| AI | **~40%** | consumer ensemble live; geological reasoning 0%, GeoContext input built not deployed |
| Production readiness (enterprise) | **~20%** | nothing deployed, no data, no write APIs |
| **Overall enterprise project** | **~38%** | weighted: foundation heavy & done, operating layer light & mostly pending |

## 12. Technical Debt
- **Security debt:** none structural (Sprint 3 PASS). Operational: config.toml schema-exposure uncommitted + entangled with payment edits; prod "Exposed schemas" unset.
- **Performance debt:** partitioning of `sample`/`audit_log` deferred (ADR-0001); GeoContext cache is Postgres-only (Redis deferred); RLS predicate indexes verified present.
- **Architecture debt:** portal-resolver adapters missing (OneGeology/BRGM/Smithsonian); ScienceBase has no stable ETag (version-based change detection needed); ontology `*_key→*_id` handled by trigger (good) but multi-valued host_rocks/commodities not ontology-FK'd.
- **Code-quality debt:** shp/GeoTIFF validation is structural-only (no GDAL); some providers return raw arrays needing normalization; enterprise write APIs will need shared validation helpers.
- **Documentation debt:** minimal — docs are ahead of code if anything; needs a deploy runbook + API contracts for the unbuilt endpoints.

## 13. Final Assessment
- **Architecture solid?** **Yes.** Coherent, layered, well-documented, ADR-backed; frozen v1.0 with a clean post-freeze extension path.
- **Database production-grade?** **Yes** (pending the actual `db push`). 100% RLS, invariant triggers, append-only audit, verified helpers, full-chain reset green.
- **Security production-grade?** **Yes** at the data layer (Sprint 3 audit PASS). Only operational deploy/config items remain.
- **Safe to move into feature implementation?** **Yes** — the foundation is stable enough that building enterprise write APIs and data pipelines on it is low-risk. This is the right moment to shift from schema to services.
- **Top 5 priorities:**
  1. Deploy the foundation to production (`db push` + schema exposure + deploy the 2 enterprise fns).
  2. Build `provision-organization` (entitlement path) + a minimal admin activation.
  3. Build the Sample Submission API (first write workflow).
  4. Load reference/ontology/GIS/occurrence data + stand up the Knowledge Extraction Pipeline (GeoContext is empty without it).
  5. Build the Verification API, then the AI Geological Reasoning Engine on top of GeoContext.

---
*All figures verified against migrations 0001–0058, the running shadow DB, `supabase/functions/`, tests, and `docs/`. Nothing beyond the repository is assumed.*

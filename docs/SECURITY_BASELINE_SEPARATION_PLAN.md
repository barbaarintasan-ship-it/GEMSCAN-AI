# Security Baseline Separation — Inventory & Plan

**Goal:** make `v1.0-security-complete` represent the **enterprise security
foundation only** — no mobile, payment, valuation, scan, or Play-Store content.

**Current problem:** the tag points to `70a8bc7`, the tip of `feat/smart-capture`,
which is **52 commits ahead of `main`** and mixes the enterprise work with
unrelated app features.

---

## 1. Inventory — 52 commits (`main..feat/smart-capture`)

Classified by the files each commit touches. `ent` = enterprise migration
(`0018`–`0043`) or enterprise doc; `feat` = mobile/payment/valuation/scan/assets;
`base` = non-enterprise base migration (`0016`/`0017` app_config).

### A. SECURITY BASELINE — 31 pure-enterprise commits (KEEP)
Contiguous block `733aa3e … 70a8bc7`, each touches **only** enterprise paths
(`feat=0`, `base=0`). Cherry-pickable onto `main` with no conflicts.

| Hash | Commit |
|---|---|
| 733aa3e | Sprint 1 — 0018 foundation (schemas, extensions, enums) + PHASE1_TEST_REPORT |
| 4f4ce46 | Sprint 2 — 0019 lookup tables |
| e7043aa | Sprint 2 — 0020 identity/orgs/contributors |
| bd75d26 | Sprint 2 — 0021 spatial core |
| 374c65d | Sprint 2 — 0022 missions |
| 162c43a | Sprint 2 — 0023 samples |
| 9bedf9c | Sprint 2 — 0024 observations |
| 25a37f1 | Sprint 2 — 0025 surveys |
| d1a9b01 | Sprint 2 — 0026 occurrence/verification/lab |
| 6fdd1cc | Sprint 2 — 0027 chain of custody |
| 8b1f551 | Sprint 2 — 0028 hooks + processing_job |
| 80c804e | Sprint 2 — 0029 event bus + notifications |
| f1cfbdf | Sprint 2 — 0030 immutable audit ledger |
| 2136169 | Sprint 2 — 0031 ML placeholders |
| 305e299 | Sprint 2 — 0032 updated_at triggers |
| 3259729 | Sprint 2 completion report + ADRs 0001-0003 |
| 44f43bf | Architecture Freeze v1.0 + Sprint 3 plan |
| af3c296 | Sprint 3 plan — reviewer feedback |
| d5bb510 | Sprint 3 — 0033 enable RLS + default-deny |
| 9187db9 | Sprint 3 — 0034 RLS helpers + role protection |
| d90b23a | Sprint 3 — 0035 tenancy policies |
| e81c21f | Sprint 3 — 0036 area policies |
| aee2fdd | Sprint 3 — 0037 sample policies |
| d9f781a | Sprint 3 — 0038 verification + Collector≠Verifier |
| abe2942 | Sprint 3 — 0039 audit + event/notification policies |
| b5c65e4 | Sprint 3 — 0040 reference/config/ml policies |
| b4bd7c5 | Sprint 3 — 0041 contributor + mission policies |
| 308a4aa | Sprint 3 — 0042 custody + geo policies |
| 4ab238c | Sprint 3 — 0043 operational service-only |
| 19dc8d4 | Sprint 3 Final Security Audit |
| 70a8bc7 | Sprint 3 Sign-off |

### B. MIXED — 1 commit (SPLIT: take docs only)
| Hash | Commit | Enterprise part (KEEP) | Non-enterprise part (DROP) |
|---|---|---|---|
| 368ae00 | "docs: finalize enterprise architecture and prepare Sprint 1" | 7 arch docs: `LuulScan-Enterprise-Architecture-v1.md`, `-Addendum.md`, `-A2-Schema-Amendment.md`, `-A3-Advanced-Extensions.md`, `-Phase1-Engineering-Spec-v1.md`, `PHASE1_ARCHITECTURE_VALIDATION.md`, `PHASE1_AUDIT_REPORT.md` | 23 files: `mobile/android/*` build config + Play-Store icons/feature-graphics/screenshots |

### C. FEATURES — 20 non-enterprise commits (EXCLUDE)
Scan/Smart-Capture, valuation, payment-UI removal, gold-prospect, LuulScan rebrand,
perf, chore. Includes the two base migrations bundled in feature commits:
`0016_app_config_build_columns.sql` (in `085db44`) and
`0017_app_config_latest_build_37.sql` (in `97d5ca5`).

Hashes: 102d1d7, d622c82, 4437094, 4ccd3e0, 673ae88, bfc3828, 586caf3, a386f0d,
085db44, b147f4e, 5172c48, 2d767a5, 69d4dbe, 2f87efc, bf46e75, 97d5ca5, 463e395,
aa39691, 067d04e, a4ce487.

---

## 2. Separability verification
- **31 baseline commits are pure** — touch only `supabase/migrations/00[18-43]` and
  `docs/` enterprise files. No conflicts when replayed on `main`.
- **Only 1 commit (368ae00) is entangled** — cleanly splittable (add its 7 docs
  explicitly; ignore its 23 mobile files).
- **Migration chain is self-contained.** Enterprise migrations `0018`–`0043` do **not**
  reference anything from `0013`–`0017` (the only "0017" hit is a comment). A branch
  from `main` yields migrations `0001`–`0012` + `0018`–`0043`; the `0013`–`0017` gap is
  harmless (the runner applies present files in order; nothing references the gap).
- Base migrations `0016`/`0017` are mobile `app_config` (build tracking) — **not**
  security; excluded from the baseline.

---

## 3. Recommended plan — fresh release branch, cherry-pick enterprise-only

Preserves the disciplined per-migration history; `main`, `feat/smart-capture`, and
all app features stay untouched.

```bash
# 1. New baseline branch from main (inherits 0001-0012 only)
git branch release/enterprise-security-v1 main
git switch release/enterprise-security-v1

# 2. Bring the 7 foundational arch docs from the mixed commit (docs only)
git checkout 368ae00 -- \
  docs/LuulScan-Enterprise-Architecture-v1.md \
  docs/LuulScan-Enterprise-Architecture-v1-Addendum.md \
  docs/LuulScan-Enterprise-Architecture-A2-Schema-Amendment.md \
  docs/LuulScan-Enterprise-Architecture-A3-Advanced-Extensions.md \
  docs/LuulScan-Enterprise-Phase1-Engineering-Spec-v1.md \
  docs/PHASE1_ARCHITECTURE_VALIDATION.md \
  docs/PHASE1_AUDIT_REPORT.md
git commit -m "docs(enterprise): foundational architecture, spec & validation"

# 3. Replay the 31 pure-enterprise commits in order
git cherry-pick 733aa3e^..70a8bc7   # applies cleanly (enterprise-only paths)

# 4. Re-point the tag to the clean baseline
git tag -d v1.0-security-complete
git tag -a v1.0-security-complete -m "Enterprise security foundation (schema 0018-0032 + RLS 0033-0043)"
```

### Verification gates (before any push)
1. `supabase db reset` on `release/enterprise-security-v1` → migrations
   `0001`–`0012` + `0018`–`0043` apply clean (exit 0); 57 enterprise/geo/ml tables,
   73 policies.
2. `git diff --name-only main..release/enterprise-security-v1` → shows **only**
   `supabase/migrations/00[18-43]*` and `docs/` enterprise files — **zero**
   `mobile/`, payment, valuation, or asset paths.
3. `git log --oneline main..release/enterprise-security-v1` → 32 commits (31 + the
   docs commit), all enterprise.

### Alternatives (not recommended)
- **Rebase/filter `feat/smart-capture`** dropping feature commits — reorders history,
  risks conflicts, mutates the working branch. Cherry-pick onto a fresh branch is safer.
- **Squash into one commit** — loses the per-migration audit trail the sprint discipline
  produced.

---

## 4. Decisions needed before execution (no git surgery until confirmed)
1. Approve the **fresh-release-branch cherry-pick** approach (§3)?
2. Branch name: `release/enterprise-security-v1` (or `feat/enterprise-security`)?
3. Exclude base migrations `0016`/`0017` from the baseline? (Recommended: **yes** —
   they are mobile app_config, not security.)
4. After branch is built **and** the three verification gates pass, re-point
   `v1.0-security-complete` to the new HEAD, then decide on push/merge separately.

**Nothing is pushed or merged until you confirm.**

# Enterprise Review Console + Company Portal — Architecture v1

The professional review + delivery layer on top of the Geological Intelligence
Engine. Geologists review AI assessments on a **large-screen web console**; company
users consume **verified reports** (read-only) through a **Company Portal**; every
sample carries an **internal discussion thread**; access is governed by
**role-based permissions**.

> Design status: **for review**, like GeoContext/GIE. Grounded in the existing
> enterprise schema (lifecycle, sample_verification, feature_flag, org_role).

---

## 1. Principles

1. **Review happens on a large screen.** Professional geological review (correcting
   interpretations, setting confidence, sign-off) is Web Console only.
2. **Mobile is read-only for review.** Collectors see their sample + the geologist's
   result and can join the discussion — they cannot review/verify.
3. **Company users never modify interpretations.** The Company Portal is read-only:
   verified reports, maps, notifications, PDF downloads.
4. **Lifecycle unchanged.** We keep Submitted → AI → awaiting_review →
   verified/needs_more_data/rejected; the console drives the transitions.
5. **Self-review is a dev-only escape hatch.** Behind a feature flag, never in prod,
   double-gated to the owner-beta account.

---

## 2. Roles & permissions (RBAC)

Extend `enterprise.contributor_role` with the professional hierarchy. Permission
matrix (✓ = allowed):

| Capability | Collector | Geologist | Senior Geol. | Chief Geol. | Company Mgr | Admin |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Submit samples (mobile) | ✓ | ✓ | ✓ | ✓ | | |
| View own samples | ✓ | ✓ | ✓ | ✓ | | ✓ |
| Review queue (console) | | ✓ | ✓ | ✓ | | ✓ |
| Correct AI conclusions | | ✓ | ✓ | ✓ | | |
| Set geologist_confidence | | ✓ | ✓ | ✓ | | |
| **Verify / sign-off** | | | ✓ | ✓ | | |
| Reject / Needs-more-data | | ✓ | ✓ | ✓ | | |
| Discussion thread | ✓ | ✓ | ✓ | ✓ | ✓(read) | ✓ |
| View **verified** reports + maps | | ✓ | ✓ | ✓ | ✓ | ✓ |
| Download professional PDF | | ✓ | ✓ | ✓ | ✓ | ✓ |
| Manage users / roles | | | | ✓(geologists) | | ✓ |

- **Geologist** reviews + corrects but a **Senior/Chief** gives the binding *verify*.
- **Company Manager** = read-only consumer of verified output (never edits geology).
- **Administrator** = platform admin (users, flags), not a geological authority.

Company users are `organization_member`s (`org_role`); internal staff are
`field_contributor`s (`contributor_role`). Authorization stays in the existing
`_shared/enterprise/authz.ts` (extend `requireRole`).

---

## 3. Data model (additive)

1. **`contributor_role`** — add `geologist`, `senior_geologist`, `chief_geologist`,
   `company_manager` (keep `field_contributor`=collector, `admin`=administrator).
2. **Reviews** — reuse `enterprise.sample_verification` (reviewer_id, level, decision,
   weight, note). `level` becomes `geologist` | `senior` | `chief`. On a binding
   verify, set `sample.status` + `sample.geologist_confidence` (AI confidence never
   touched) via a `review-sample` RPC (audited).
3. **`enterprise.sample_discussion`** (new) — per-sample thread: id, sample_id, author_id,
   author_role, body, created_at. RLS: anyone who can read the sample (collector,
   assigned geologists, org company users) can read; those roles can post.
4. **Conclusion corrections** — `geo.assessment_conclusion` gains
   `reviewed_by`, `review_state` (`confirmed`|`corrected`|`rejected`), `corrected_statement`.
   The AI's original text is never overwritten (traceability); corrections are additive.
5. **`self_review` feature flag** — `enterprise.feature_flag` row (`default_enabled=false`,
   `is_beta=true`). The Collector≠Verifier trigger skips enforcement **only** when the
   flag is enabled AND the reviewer is the owner-beta email (double gate). Documented
   dev-only; never enabled in production.

---

## 4. Review workflow (console → delivery)

```
awaiting_review
   → geologist opens sample: photos + AI evidence graph + GPS/map + discussion
   → confirms/corrects each conclusion, sets geologist_confidence, writes notes
   → Geologist: recommends;  Senior/Chief: VERIFY (binding) | Needs-More-Data | Reject
review-sample RPC: writes sample_verification + conclusion review_state +
   sample.status + geologist_confidence + audit + notification(collector)
   → verified → feeds the KB (learning loop, later) + available to Company Portal
```

**Delivery:** on verify, an `enterprise.event` + `notification` targets the collector
(mobile "Geologist Review" section) and the company org (portal). A professional
**PDF report** is generated on demand from the verified assessment.

---

## 5. Surfaces

- **Enterprise Review Console (web)** — a new React/Vite app in `console/`, same
  Supabase backend (user JWT + RBAC). Screens: Login → Review Queue → Sample Review
  (photos | AI evidence graph | map | discussion | decision) → Users/Admin.
  Hosting: static build (Supabase hosting / Vercel), env-injected Supabase URL+anon key.
- **Company Portal (web)** — read-only area of the same app (or a sibling route),
  gated to `company_manager`/`org viewer`: verified reports list, map, notifications,
  PDF download. No edit controls rendered.
- **Mobile (read-only review)** — the existing Sample Detail gains a "Geologist Review"
  section + the discussion thread (post/read), but no review/verify controls.

---

## 6. PDF reports

Server-side (an Edge Function `sample-report`) renders a professional PDF from the
verified assessment: header (sample, collector, GPS, map thumbnail), AI + geologist
confidence, conclusions with evidence, recommendations, uncertainties, reviewer +
sign-off, dataset lineage/citations. Access gated by RBAC (verified samples only for
company users).

---

## 7. Safety — self-review dev flag

- Flag `self_review` defaults **off**; `is_beta=true`.
- The Collector≠Verifier trigger allows self-review **only if**: flag on **and**
  reviewer email = owner-beta. Two independent gates.
- Never toggled in production (operational rule + documented). A prod smoke check can
  assert the flag is off.

---

## 8. Slice plan

- **S1 — RBAC + schema foundation**: extend contributor_role; `sample_discussion`;
  conclusion review columns; `self_review` flag + trigger gate. (backend, migrations)
- **S2 — review-sample endpoint + authz**: RPC + Edge Function; `requireRole`
  extensions; audit + notification. Unit + shadow tests.
- **S3 — Web Console scaffold + auth + Review Queue**.
- **S4 — Sample Review screen** (photos | evidence graph | map | decision) + corrections.
- **S5 — Discussion thread** (web + mobile read/post) + mobile "Geologist Review" section.
- **S6 — Company Portal** (read-only reports + maps + notifications).
- **S7 — PDF report** Edge Function + download.
- **S8 — Learning loop** (verified → KB) — ties into GIE S7.

Each slice: schema/logic + tests + shadow verification, committed independently.

---

## 9. Open decisions

1. **Web console framework/hosting** — React + Vite, hosted on Vercel vs Supabase
   static hosting vs Netlify. (Recommendation: Vite + Vercel; env-injected keys.)
2. **PDF engine** — server-side (Edge Function with a PDF lib) vs a print-friendly HTML
   route the browser prints. (Recommendation: Edge Function for a consistent artifact.)
3. **Beta reviewer** — add a second geologist account, or rely on the dev self-review
   flag for the owner during beta.

# Luul Scan Enterprise — Architecture Amendment A2
## Phase 1 Schema Amendment (resolves the validation-report Critical & key Major items)

| | |
|---|---|
| **Extends** | Architecture v1.0 · Addendum A1 · Phase 1 Engineering Spec v1.0 |
| **Triggered by** | [Phase 1 Architecture Validation Report](./PHASE1_ARCHITECTURE_VALIDATION.md) |
| **Amendment** | A2 |
| **Status** | Design only — **no code, SQL, or migrations**. Folds the Critical + high-value Major schema changes into the Phase-1 design so the schema can be safely frozen. |

> A2 makes the design **production-safe to freeze**. It is still **design only**. Every `…` fragment is illustrative shape for the migration author, not a migration. All original principles hold: no certainty claims · no replacing geologists · probabilistic only · consumer/enterprise separation.

---

## Contents
- **A2.1** New/updated enum types
- **A2.2** Critical fixes (4)
- **A2.3** Major fixes (schema)
- **A2.4** Security requirements (implementation acceptance criteria)
- **A2.5** Storage requirements
- **A2.6** Scalability requirements
- **A2.7** Updated affected sections (deltas)
- **A2.8** Frozen Phase-1 table list
- **A2.9** Schema-freeze confirmation

---

## A2.1 — New / updated enum types

```text
enterprise.org_role          = (owner, admin, member, viewer)         -- org membership
enterprise.audit_action      = (insert, update, delete, verify, promote, login, export)
enterprise.finding_type      = (sample_collected, no_mineralization, inaccessible, other)  -- absence support
enterprise.sample_method     = (grab, rock_chip, channel, soil, stream_sediment, float, other)
enterprise.alteration_type   = (silicification, sericitic, argillic, propylitic, potassic, oxidation, carbonate, other)
enterprise.alteration_grade  = (none, weak, moderate, strong, pervasive)
enterprise.structure_type    = (vein, fault, fold, foliation, joint, shear, contact, bedding)
enterprise.assignment_status = (assigned, in_progress, completed, skipped, expired)
-- verification split reuses existing review_decision + a level text ('community'|'expert')
```

Existing A1/spec enums are unchanged.

---

## A2.2 — Critical fixes

### A2.2.1 Organization / tenant model  🔴 (validation §4.1, §9)
**Problem:** `project.tenant_id` referenced nothing → tenant/project isolation was unimplementable.

**Fix — two real entities + FK:**

```text
enterprise.organization
  id uuid pk
  name text not null
  slug text unique
  plan text                      -- enterprise plan tier
  status text default 'active'
  created_by uuid                -- auth.users
  created_at / updated_at timestamptz
  deleted_at timestamptz         -- soft delete

enterprise.organization_member
  organization_id uuid  -> organization(id)
  user_id uuid          -> auth.users(id)
  role enterprise.org_role not null default 'member'
  added_at timestamptz
  PK (organization_id, user_id)
  Index: btree(user_id)
```

- **`project.tenant_id` → replaced by `project.organization_id` (FK → organization.id).**
- **Tenant isolation rule (now implementable):** a row is visible to a user iff
  `EXISTS (select 1 from organization_member m where m.organization_id = <row org> and m.user_id = auth.uid())`.
- **RLS:** org rows readable by members; managed by `owner`/`admin`. This single predicate powers every private-project policy.

### A2.2.2 Audit logging + soft-delete + created_by  🔴 (validation §9, §1.4/1.5)

```text
enterprise.audit_log            -- append-only, service/admin read only
  id uuid pk
  actor_id uuid                 -- auth.users (nullable for system)
  action enterprise.audit_action not null
  entity_type text not null     -- 'exploration_area' | 'sample' | ...
  entity_id uuid not null
  before jsonb                  -- prior row (for update/delete)
  after jsonb                   -- new row
  context jsonb                 -- request id, function name, ip (hashed)
  created_at timestamptz default now()
  Index: btree(entity_type, entity_id), btree(actor_id), brin(created_at)
```

- **Convention added to all mutable enterprise tables:** `created_by uuid`, `updated_by uuid`, `deleted_at timestamptz` (soft delete).
- **Reads exclude soft-deleted** via a standard filtered view / policy (`deleted_at is null`).
- Audit rows are written by Edge Functions (service role); **never** client-writable; **never** updated/deleted.

### A2.2.3 Column-level protection of role & reputation  🔴 (validation §4.2)
**Problem:** row-level RLS let a user set their own `role`/`reputation_score`.

**Fix (primary):** **column-level privileges** — grant `authenticated` UPDATE on **non-privileged columns only**:

```text
-- design intent (migration author):
GRANT UPDATE (home_region, training_level) ON enterprise.field_contributor TO authenticated;
-- role, reputation_score, status are NOT granted → only service role (Edge Fn) can change them
```

- **Backstop:** a `BEFORE UPDATE` trigger rejects any change to `role`/`reputation_score`/`status` unless `current_setting('role')` is service/admin.
- **Elevation** happens only via an admin/service Edge Function (validation §7-D3). Default new users = `normal`. No self-elevation is possible even with a crafted request.

### A2.2.4 Absence / negative observation + survey track  🔴 (validation §6.1 — AI validity)
**Problem:** presence-only data → future models can't learn "not gold" → severe bias.

**Fix — two lightweight entities:**

```text
enterprise.survey_track          -- "where a contributor looked" (coverage of effort)
  id uuid pk
  area_id uuid -> exploration_area(id)
  mission_id uuid -> exploration_mission(id)   -- nullable
  contributor_id uuid -> auth.users(id)
  path geography(LineString,4326)              -- optional traversed path
  started_at / ended_at timestamptz
  h3_cells text[]                              -- cells covered (denormalized for coverage)
  created_at timestamptz
  Index: GIST(path), btree(area_id), btree(contributor_id)

enterprise.field_observation_point   -- generalizes positive & NEGATIVE findings
  id uuid pk (client-suppliable)
  area_id uuid -> exploration_area(id)
  survey_track_id uuid -> survey_track(id)     -- nullable
  contributor_id uuid -> auth.users(id)
  location geography(Point,4326) not null
  h3_cell text not null
  finding enterprise.finding_type not null      -- includes no_mineralization
  sample_id uuid -> sample(id)                   -- set when finding = sample_collected
  notes text
  created_at timestamptz
  Index: GIST(location), btree(area_id), btree(h3_cell), btree(finding)
```

- A **positive** finding links to a `sample`; a **negative** finding (`no_mineralization`) is first-class training data (absence).
- Coverage intelligence now counts **effort** (survey_track / observation points), not just samples — de-biasing prospectivity.

---

## A2.3 — Major fixes (schema)

### A2.3.1 Mission assignment & progress  (validation §1.3)
```text
enterprise.mission_assignment
  id uuid pk
  mission_id uuid -> exploration_mission(id)
  contributor_id uuid -> auth.users(id)
  target_h3 text                      -- cell to cover
  due_at timestamptz
  status enterprise.assignment_status default 'assigned'
  created_at timestamptz
  Index: btree(mission_id), btree(contributor_id), btree(status)

enterprise.mission_progress           -- materialized/derived, 1:1 mission
  mission_id uuid pk -> exploration_mission(id)
  observation_count int default 0
  sample_count int default 0
  coverage_pct numeric(5,2) default 0
  updated_at timestamptz
```

### A2.3.2 Verification split (integrity fix)  (validation §1.1)
Replace the polymorphic `verification_record` with two FK-backed tables:

```text
enterprise.sample_verification
  id uuid pk
  sample_id uuid -> sample(id)
  reviewer_id uuid -> auth.users(id)
  level text not null            -- 'community' | 'expert'
  decision enterprise.review_decision not null
  weight numeric(5,2) not null
  note text
  created_at timestamptz
  Unique (sample_id, reviewer_id, level)
  Index: btree(sample_id), btree(reviewer_id)

enterprise.occurrence_verification
  id uuid pk
  occurrence_id uuid -> occurrence_evidence(id)
  reviewer_id uuid -> auth.users(id)
  level / decision / weight / note / created_at   -- same shape
  Unique (occurrence_id, reviewer_id, level)
```

Real FKs, clean RLS, no polymorphism.

### A2.3.3 Score configuration  (validation §1.6)
```text
enterprise.score_config           -- tunable weights & thresholds (no redeploy to change)
  key text pk                      -- e.g. 'field_reliability.weights', 'area.verified_threshold'
  value jsonb not null
  description text
  updated_by uuid
  updated_at timestamptz
```
Edge Functions read weights/thresholds from here (with safe in-code defaults). Admin-only writes.

### A2.3.4 Geological depth  (validation §7)
```text
-- on sample:
sample + sample_method enterprise.sample_method     -- grab/chip/channel/soil/stream/float
sample + formation_id uuid -> geo.geological_layer(id)   -- nullable lithology link

enterprise.alteration_observation
  id uuid pk
  sample_id uuid -> sample(id)
  alteration_type enterprise.alteration_type
  intensity enterprise.alteration_grade
  notes text
  method enterprise.obs_method default 'field'
  created_at timestamptz
  Index: btree(sample_id), btree(alteration_type)

enterprise.structural_measurement
  id uuid pk
  sample_id uuid -> sample(id)
  structure_type enterprise.structure_type
  strike_deg numeric(5,2)     -- 0..360 (CHECK)
  dip_deg numeric(5,2)        -- 0..90  (CHECK)
  dip_direction numeric(5,2)  -- optional
  notes text
  created_at timestamptz
  Index: btree(sample_id), btree(structure_type)
```

### A2.3.5 Boundary geometry fix  (validation §2.1–2.2)
- `exploration_area.boundary` → **`geography(MultiPolygon,4326)`** (accepts disjoint boundaries).
- Add an optional **generated projected `geometry`** column for area/length analytics (planned projection); storage stays geography for global `ST_DWithin`.
- `coverage_cell` / `survey_track` geometry SRIDs standardized to 4326.

### A2.3.6 Incremental coverage  (validation §2.5, §8.1)
- **Design change (not schema):** on `submit-sample` / observation ingest, **upsert-increment** the relevant `coverage_cell` (sample_count/verified_count/last_sampled_at) inside the same transaction. A nightly `pg_cron` **reconciliation** repairs drift. **No full materialized refresh** at 10M scale.

### A2.3.7 Constraints & indexes (validation §1.7, §1.9, §1.10)
- CHECK: all `*_score` in [0,100]; `gps_accuracy_m >= 0`; `strike_deg` 0–360; `dip_deg` 0–90; counts `>= 0`.
- Every FK column indexed (audit the full set at migration time).
- GIN on queried JSONB (`assay`, `indicator_flags`, `ml_feature.features`).

---

## A2.4 — Security requirements (implementation acceptance criteria)

These are **binding acceptance criteria** for Sprint 3/5 (not new tables):

1. **Server-side authorization** in every Edge Function — verify the caller's **DB role**, not just a valid JWT (validation §4.3). Expert-level verification, `lab_result`, and high-tier `occurrence_evidence` inserts reject non-expert/admin callers.
2. **No trust in stale JWT claims** — sensitive actions re-check the DB role/membership (validation §4.4).
3. **`organization_member` / `area_membership` self-insert blocked** — managed only by `owner`/`admin`/`team_leader` (validation §4.5).
4. **Community read gating** — SELECT policies hide others' samples until `status ≥ community_confirmed` (validation §4.6).
5. **Signed-URL authorization** — the signing function authorizes the caller against the object's `area_id`/`organization_id` before signing (validation §4.7).
6. **Service-role key** never ships to the client (validation §4.8). Direct client INSERT disabled on `sample`, `sample_media`, `occurrence_evidence`, `sample_verification`, `occurrence_verification`, `audit_log`.
7. **RLS test matrix** (STEP 6) proves: anon = denied; normal = community-only; contributor = own + confirmed; org member = own tenant; cross-tenant = denied; self-escalation = denied.

---

## A2.5 — Storage requirements

1. **Signed direct-to-storage upload** (client → storage) with the **on-device quality gate** as the primary filter; **async** server quality scoring + thumbnailing (storage trigger / queue), not in the request path (validation §5.1–5.2).
2. **Orphaned-media retention:** a scheduled job deletes media for samples that never reach `complete` within a TTL (validation §5.3).
3. **Signed-URL fan-out** on maps mitigated by batch signing / cached thumbnails (validation §5.4).
4. **Target sizes** defined for originals vs thumbnails to control cost (validation §5.5, §8.2).
5. Buckets remain private; path convention unchanged: `sample-media/{area_id}/{sample_id}/{role}-{media_id}.jpg`.

---

## A2.6 — Scalability requirements

1. **Partition from day one:** `sample` and `sample_media` **time-partitioned (monthly)** — declared in Sprint 2, not retrofitted (validation §8.3).
2. **Incremental coverage** (A2.3.6) instead of full refresh (validation §8.1).
3. **Storage tiering** plan (hot thumbnails / cold originals) + retention for the 10M-sample horizon (validation §8.2).
4. **Read replicas** for analytics; **staggered `pg_cron`**; VACUUM/bloat monitoring on large GIST indexes (validation §8.4–8.5).

---

## A2.7 — Updated affected sections (deltas)

- **Phase-1 Spec Deliverable 1 (DB):** add `organization`, `organization_member`, `audit_log`, `survey_track`, `field_observation_point`, `mission_assignment`, `mission_progress`, `sample_verification`, `occurrence_verification`, `score_config`, `alteration_observation`, `structural_measurement`; extend `sample` (`sample_method`, `formation_id`, `created_by`, `deleted_at`); replace `project.tenant_id` → `project.organization_id`; retire polymorphic `verification_record`.
- **Deliverable 3 (Security):** tenant predicate now concrete (A2.2.1); column-level role protection (A2.2.3); acceptance criteria (A2.4).
- **Deliverable 4 (Edge Functions):** `submit-sample` also increments coverage + writes `field_observation_point`; new admin fn `set-contributor-role`; verification fns target the split tables; all fns write `audit_log`.
- **Deliverable 6 (Offline):** local queue also carries `survey_track` + negative observations; idempotent completeness re-check on late media (validation §3.4); locked status recompute (validation §3.5).
- **AI roadmap:** absence data (A2.2.4) + effort coverage feed unbiased training; only highest-tier evidence labels positives (unchanged).

---

## A2.8 — Frozen Phase-1 table list (post-A2)

**enterprise:** organization · organization_member · field_contributor · project · exploration_area · area_membership · exploration_mission · mission_area · mission_contributor · mission_assignment · mission_progress · sample · sample_location · sample_media · sample_device_context · rock_observation · mineral_observation · alteration_observation · structural_measurement · survey_track · field_observation_point · sample_verification · occurrence_verification · evidence_tier · occurrence_evidence · lab_result · score_config · audit_log

**geo:** geological_layer · coverage_cell

**ml:** ml_feature · ml_model · ml_score

Common conventions on all mutable enterprise tables: UUID PK · `created_at`/`updated_at` (+ `updated_at` trigger) · `created_by` · `deleted_at` (soft delete) · RLS on · CHECK constraints · every FK indexed · GIST on geo columns.

---

## A2.9 — Schema-freeze confirmation

With Amendment A2 folded in:

- ✅ All **4 Critical** items resolved (tenant model, role protection, audit logging, absence/effort data).
- ✅ Key **Major** items resolved in-schema (mission assignment/progress, verification integrity, score config, geology depth, boundary geometry, incremental coverage) or captured as **binding acceptance criteria** (security, storage, scalability).
- ✅ Consumer app remains untouched; enterprise stays additive & isolated.

**The Phase-1 schema is now safe to FREEZE.** Remaining Minor/Optional items (FTS, webhooks, activity timeline, enterprise billing/analytics) are explicitly deferred to later phases and do not block Sprint 2.

**Next (on approval):** Sprint 1 Implementation Plan → migrations (`0018_`…) → RLS → Edge Functions → offline sync → RN integration — built exactly to v1.0 + A1 + Phase-1 Spec + **A2**.

---

*End of Amendment A2. Design only — no code, SQL, or migrations produced.*

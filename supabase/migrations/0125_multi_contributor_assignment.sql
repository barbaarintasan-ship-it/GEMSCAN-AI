-- 0125_multi_contributor_assignment.sql
--
-- Phase 4 (Solo→Team shared-targeting) — Multi-Contributor Assignment, schema.
-- Approved design: OPTION B (audit) — same enterprise.mission_assignment
-- table, uniqueness split into two PARTIAL indexes instead of one:
--
--   A. UNIQUE (mission_id, target_h3) WHERE contributor_id IS NULL
--      — exactly one CANONICAL cell row per generated cell. This is the cell
--      INTELLIGENCE record (area_id, prospectivity_score, scored_at,
--      score_engine_version) and is never assigned to anyone directly.
--   B. UNIQUE (mission_id, target_h3, contributor_id) WHERE contributor_id IS NOT NULL
--      — one row per (cell, contributor). Any number of contributors may
--      hold the same cell simultaneously; the same contributor cannot hold
--      the same cell twice.
--
-- NOT a 3-column replacement of the old 2-column index (the audit's own
-- finding: that breaks generate_mission_cells's ON CONFLICT inference and
-- has a NULL-uniqueness hole that would let repeated generation create
-- duplicate canonical rows). Two narrower partial indexes instead.
--
-- PRE-FLIGHT (verified before writing this migration, not assumed):
--   select count(*), count(*) filter (where contributor_id is null),
--          count(*) filter (where contributor_id is not null)
--     from enterprise.mission_assignment;
--   -- 38 total / 32 unassigned (already canonical) / 6 assigned (need backfill)
--   select mission_id, target_h3, count(*) from enterprise.mission_assignment
--     group by mission_id, target_h3 having count(*) > 1;
--   -- zero rows — the OLD single (mission_id, target_h3) unique index already
--   -- guaranteed this, so no duplicate-collision risk exists going in.
--   select count(*) from enterprise.mission_assignment where prospectivity_score is not null;
--   -- zero — no live mission has been scored yet, so score-preservation during
--   -- backfill has no real data to lose, though the logic below handles it
--   -- generally (copies score fields forward) in case that changes before
--   -- this migration lands.
--
-- ORDER MATTERS: the OLD index must be dropped BEFORE the backfill insert,
-- because the backfill inserts a SECOND row sharing (mission_id, target_h3)
-- with an already-assigned row — which the old index forbids. The two NEW
-- partial indexes are created LAST, so if the backfill produced anything
-- that violates them (it shouldn't — see verification below), the migration
-- fails loudly here rather than silently shipping bad data.

-- ── STEP 1 — drop the old single index ──────────────────────────────────────
drop index if exists enterprise.uq_mission_assignment_mission_h3;

-- ── STEP 2 — backfill: give every currently-assigned cell its own canonical
-- (contributor_id IS NULL) row, carrying the cell-level facts forward ───────
-- Legacy shape: one row per cell, contributor_id set directly on it.
-- New shape needs: that SAME row re-expressed as a pure assignment row, PLUS
-- a new canonical row holding area_id/target_h3/mission_id/score fields.
-- `not exists` guards this being safely re-run (it is not expected to be,
-- but costs nothing to guard).
insert into enterprise.mission_assignment
  (mission_id, target_h3, contributor_id, area_id, status,
   prospectivity_score, scored_at, score_engine_version, created_at)
select
  src.mission_id, src.target_h3, null, src.area_id, 'assigned',
  src.prospectivity_score, src.scored_at, src.score_engine_version, src.created_at
from enterprise.mission_assignment src
where src.contributor_id is not null
  and not exists (
    select 1 from enterprise.mission_assignment pool
    where pool.mission_id = src.mission_id
      and pool.target_h3 = src.target_h3
      and pool.contributor_id is null
  );

-- ── STEP 3 — the score now lives on exactly one row (the canonical one) ────
-- Pre-flight showed zero scored rows today, so this is a no-op on current
-- data — kept general so it is still correct the day scoring and assignment
-- are both in use.
update enterprise.mission_assignment
  set prospectivity_score = null, scored_at = null, score_engine_version = null
  where contributor_id is not null
    and (prospectivity_score is not null or scored_at is not null or score_engine_version is not null);

-- ── STEP 4 — the two new partial unique indexes ─────────────────────────────
-- If STEP 2/3 left any data that violates these, index creation fails here —
-- the migration aborts rather than shipping a silently-broken uniqueness model.
create unique index if not exists uq_mission_assignment_cell
  on enterprise.mission_assignment (mission_id, target_h3)
  where contributor_id is null;

create unique index if not exists uq_mission_assignment_contributor
  on enterprise.mission_assignment (mission_id, target_h3, contributor_id)
  where contributor_id is not null;

-- New audit_action label for 0126's unassign RPC. Own migration, ahead of
-- any DML that uses it — same reason 0113/0115/0121/0123 did this.
-- ('mission_assign_cells' already exists since 0115 and is reused for BOTH
-- the first assignment and every additional one — see 0126's own comment
-- for why a second enum value wasn't added for that case.)
alter type enterprise.audit_action add value if not exists 'mission_unassign_cell';

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select count(*) from enterprise.mission_assignment; -- expect old total + backfilled rows
--   select count(*) filter (where contributor_id is null) as canonical,
--          count(*) filter (where contributor_id is not null) as assignments
--     from enterprise.mission_assignment;
--   select mission_id, target_h3, count(*) filter (where contributor_id is null) as canonical_count
--     from enterprise.mission_assignment group by mission_id, target_h3
--     having count(*) filter (where contributor_id is null) <> 1; -- expect zero rows
--   select indexname from pg_indexes where schemaname='enterprise'
--     and tablename='mission_assignment' and indexname like 'uq_mission_assignment%';

-- ── ROLLBACK (down-path) ────────────────────────────────────────────────────
--   drop index if exists enterprise.uq_mission_assignment_cell;
--   drop index if exists enterprise.uq_mission_assignment_contributor;
--   -- Backfilled canonical rows would need manual removal (join back on
--   -- created_at/area_id to identify them) before recreating the old single
--   -- index — this migration is not designed to be silently reversed once
--   -- new multi-contributor assignments exist on top of it.
--   create unique index uq_mission_assignment_mission_h3
--     on enterprise.mission_assignment (mission_id, target_h3) where target_h3 is not null;
--   -- audit_action enum VALUES cannot be dropped in Postgres; leaving
--   -- 'mission_unassign_cell' unused is the rollback for that part.

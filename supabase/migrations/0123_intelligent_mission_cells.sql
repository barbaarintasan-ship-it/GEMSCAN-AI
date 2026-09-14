-- 0123_intelligent_mission_cells.sql
--
-- Phase 3 (Solo→Team shared-targeting) — Intelligent Mission Cells, schema.
--
-- Turns the geometric-only H3 grid (generate_mission_cells, 0116) into a
-- geologically ranked one. Reuses the EXISTING enterprise.mission_assignment
-- row (one per generated cell) rather than a new table — per the
-- architecture note, cell INTELLIGENCE and cell ASSIGNMENT are different
-- concepts but the SAME row: a cell can be scored with no contributor_id at
-- all ("ranked, nobody assigned yet").
--
-- Three nullable, additive columns. Existing rows (cells generated before
-- this migration) simply have prospectivity_score = null — a real, honest
-- "not yet scored" state, not zero and not hidden. Existing readers
-- (fetchMissionAssignments, manager-mission screen, assign_mission_cells)
-- are unaffected: none of them SELECT * or otherwise required a fixed
-- column count.
--
--   prospectivity_score  — the deterministic score (0..1, NOT a probability)
--                          the shared TargetingEngine computed for this exact
--                          cell centre. Same meaning as
--                          ExplorationTarget.score / the Phase 2
--                          source_target_score on exploration_area — just at
--                          cell granularity instead of target granularity.
--   scored_at            — when that score was computed. A SNAPSHOT, not a
--                          permanent fact — Phase 8 (field evidence -> mission
--                          re-score) will update both columns together when
--                          it lands; nothing here assumes the score is
--                          forever current.
--   score_engine_version — which server GeoContext engine version produced
--                          it (see TEAM_TARGETING_ENGINE_VERSION,
--                          serverGeoContext.ts). Recorded so a later
--                          evidence-source upgrade (e.g. structural/
--                          lithology/terrain becoming server-available) can
--                          identify which cells were scored under the
--                          narrower Phase 1-3 evidence set and may be worth
--                          refreshing — never inferred, always read off the
--                          row.
--
-- Depends on: 0115 (mission_assignment), 0030 (audit_action enum).

alter table enterprise.mission_assignment
  add column if not exists prospectivity_score numeric(5,2),
  add column if not exists scored_at timestamptz,
  add column if not exists score_engine_version text;

do $$ begin
  alter table enterprise.mission_assignment
    add constraint ck_mission_assignment_score
      check (prospectivity_score is null or (prospectivity_score >= 0 and prospectivity_score <= 1));
exception when duplicate_object then null;
end $$;

comment on column enterprise.mission_assignment.prospectivity_score is
  'Deterministic prospectivity score (0..1, NOT a probability) the shared TargetingEngine computed for this cell''s centre. Null = not yet scored. Independent of contributor_id — a cell can be ranked with nobody assigned.';
comment on column enterprise.mission_assignment.scored_at is
  'When prospectivity_score was computed. A snapshot — see Phase 8 (field-evidence re-scoring) for when this is expected to change.';
comment on column enterprise.mission_assignment.score_engine_version is
  'The server GeoContext engine version (see serverGeoContext.ts) that produced prospectivity_score — lets a later evidence-source upgrade identify cells scored under a narrower evidence set.';

-- New audit_action label for 0124's score_mission_cells RPC. Own migration,
-- ahead of any DML that uses it — same reason 0113/0115/0121 did this.
alter type enterprise.audit_action add value if not exists 'mission_score_cells';

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select column_name from information_schema.columns
--     where table_schema='enterprise' and table_name='mission_assignment'
--     and column_name in ('prospectivity_score','scored_at','score_engine_version');
--   select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
--     where t.typname = 'audit_action' and enumlabel = 'mission_score_cells';

-- ── ROLLBACK (down-path) ────────────────────────────────────────────────────
--   alter table enterprise.mission_assignment drop constraint if exists ck_mission_assignment_score;
--   alter table enterprise.mission_assignment
--     drop column if exists prospectivity_score,
--     drop column if exists scored_at,
--     drop column if exists score_engine_version;
--   -- audit_action enum VALUES cannot be dropped in Postgres; leaving
--   -- 'mission_score_cells' unused is the rollback.

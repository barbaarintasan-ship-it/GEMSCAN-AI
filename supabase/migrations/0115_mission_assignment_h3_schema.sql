-- 0115_mission_assignment_h3_schema.sql
--
-- Phase 2B — H3 area enumeration and field assignment. Small additive
-- changes to the EXISTING `enterprise.mission_assignment` table (no new
-- table, per the brief):
--
--   1. `area_id` — nullable FK to the exploration_area that produced a given
--      cell. A mission may have more than one linked area (mission_area is
--      M:N); when two of a mission's areas overlap, the SAME H3 cell can only
--      ever be enumerated once per mission (see the unique index below), so
--      this records provenance as "the area that generated the cell FIRST" —
--      it is not a claim that the cell belongs exclusively to that area
--      geologically. H3 cells are a work-allocation overlay, not a
--      geological boundary (per the brief) — this column exists purely for
--      "which area was I told to cover when I got this cell," nothing more.
--   2. A unique (mission_id, target_h3) index — the server-side enforcement
--      Step 10 asks for: pressing "generate" twice, or generating from two
--      overlapping areas, must not create duplicate assignment rows. This is
--      also what makes `ON CONFLICT (mission_id, target_h3) DO NOTHING`
--      possible in the next migration's generate_mission_cells() RPC.
--
-- Two new audit_action labels, in their own migration ahead of the RPCs that
-- use them — same 0078/0084 lesson Phase 2A already applied.

alter table enterprise.mission_assignment
  add column if not exists area_id uuid references enterprise.exploration_area(id) on delete set null;

create index if not exists idx_mission_assignment_area on enterprise.mission_assignment(area_id);

-- Partial: target_h3 is nullable in the existing column definition even
-- though every row this feature creates always sets it; the guard just keeps
-- the index from ever being asked to enforce uniqueness over NULLs.
create unique index if not exists uq_mission_assignment_mission_h3
  on enterprise.mission_assignment(mission_id, target_h3)
  where target_h3 is not null;

alter type enterprise.audit_action add value if not exists 'mission_generate_cells';
alter type enterprise.audit_action add value if not exists 'mission_assign_cells';

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select column_name from information_schema.columns
--     where table_schema='enterprise' and table_name='mission_assignment' and column_name='area_id';
--   select indexname from pg_indexes where schemaname='enterprise'
--     and tablename='mission_assignment' and indexname='uq_mission_assignment_mission_h3';
--   select count(*) from unnest(enum_range(null::enterprise.audit_action)) v
--     where v::text in ('mission_generate_cells','mission_assign_cells'); -- = 2

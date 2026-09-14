-- 0121_ai_recommended_area.sql
--
-- Phase 2 (Solo→Team shared-targeting) — AI Recommended Area, schema.
--
-- Adds the minimum provenance needed to record that an enterprise.exploration_area
-- was generated from the shared deterministic targeting engine (Phase 1's
-- team-targeting) rather than drawn by hand — reusing the EXISTING
-- exploration_area table, per the architecture note that Team must not grow a
-- second geological engine or a second area table.
--
-- Four nullable, additive columns — no existing row/query is affected.
-- created_at/created_by (already on the table since 0021) already cover
-- "when" and "who"; these four cover "from what geological recommendation":
--   source_target_h3      — the H3 resolution-7 cell the engine recommended.
--   source_target_score   — the deterministic prospectivity score (0..1, NOT
--                            a probability) the server RECOMPUTED for that
--                            cell at the moment the manager accepted it.
--                            Never a client-supplied value — see
--                            enterprise.create_mission_area_from_target
--                            (0122) and accept-recommended-area/handler.ts,
--                            both of which independently refuse to trust one.
--   source_commodity      — the commodity profile code the recommendation was
--                            scored under, or null for the universal engine —
--                            mirrors ExplorationTarget.scoredForCommodity.
--   source_envelope_rings — how many H3 k-rings around source_target_h3 were
--                            unioned into this area's boundary polygon. An
--                            OPERATIONAL default (documented as
--                            EXPLORATION_ENVELOPE_RINGS in
--                            accept-recommended-area/handler.ts), not a
--                            geological measurement — recorded so a later
--                            phase can tell how an old area was sized without
--                            guessing.
--
-- Depends on: 0021 (exploration_area), 0018 (area_origin enum), 0030
-- (audit_action enum).

alter table enterprise.exploration_area
  add column if not exists source_target_h3 text,
  add column if not exists source_target_score numeric(5,2),
  add column if not exists source_commodity text,
  add column if not exists source_envelope_rings integer;

do $$ begin
  alter table enterprise.exploration_area
    add constraint ck_exploration_area_source_score
      check (source_target_score is null or (source_target_score >= 0 and source_target_score <= 1));
exception when duplicate_object then null;
end $$;

comment on column enterprise.exploration_area.source_target_h3 is
  'H3 resolution-7 cell the server-side TargetingEngine recommended, when this area was created via "AI Recommended Area" (Phase 2). Null for a manually drawn or seed area.';
comment on column enterprise.exploration_area.source_target_score is
  'The deterministic prospectivity score (0..1, NOT a probability) the server recomputed for source_target_h3 at accept time. Never a client-supplied value.';
comment on column enterprise.exploration_area.source_commodity is
  'The commodity profile code the recommendation was scored under, or null for the universal engine.';
comment on column enterprise.exploration_area.source_envelope_rings is
  'How many H3 k-rings around source_target_h3 were unioned into this area''s boundary polygon — an operational default, not a geological measurement.';

-- A new origin distinguishing "manager accepted a deterministic recommendation"
-- from the existing 'user' (hand-drawn) and 'seed' (bulk-loaded) origins.
-- Must land in its own migration/transaction, ahead of any DML that uses it
-- (0122) — same reason 0113/0115 added audit_action values ahead of their RPCs.
alter type enterprise.area_origin add value if not exists 'ai_recommended';

-- New audit_action label for 0122's create_mission_area_from_target RPC.
alter type enterprise.audit_action add value if not exists 'mission_create_area';

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select column_name from information_schema.columns
--     where table_schema='enterprise' and table_name='exploration_area'
--     and column_name like 'source_%';
--   select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
--     where t.typname = 'area_origin' order by e.enumsortorder;

-- ── ROLLBACK (down-path) ────────────────────────────────────────────────────
--   alter table enterprise.exploration_area drop constraint if exists ck_exploration_area_source_score;
--   alter table enterprise.exploration_area
--     drop column if exists source_target_h3,
--     drop column if exists source_target_score,
--     drop column if exists source_commodity,
--     drop column if exists source_envelope_rings;
--   -- area_origin/audit_action enum VALUES cannot be dropped in Postgres;
--   -- leaving 'ai_recommended'/'mission_create_area' unused is the rollback.

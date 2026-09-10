-- 0117_sample_mission_h3_schema.sql
--
-- Phase 2C — connect field samples to Enterprise team missions. Small
-- additive schema only; enterprise.sample.mission_id already exists
-- (0023_samples.sql) and has simply never been populated by any version of
-- submit_sample — this migration adds the two columns that were genuinely
-- missing, nothing else:
--
--   sample.outside_assignment (nullable boolean) — Step 5's "this is a
--   geological exception, not necessarily an error": true when a mission
--   sample's actual GPS location fell outside the submitting contributor's
--   ACTIVE assigned H3 cell. NULL for personal samples / samples with no
--   mission context (not applicable, not "false").
--
--   sample_location.location_origin (text, default 'observed') — Step 7's
--   GPS provenance distinction. Plain text + check constraint, matching the
--   existing style already used for sample_review.status/decision (0077),
--   not a new enum type — avoids the enum-add-value-then-use-same-transaction
--   pitfall this codebase already hit twice (0084, and again in this
--   session's Phase 2A/2B audit_action additions). Defaults to 'observed'
--   so every existing row and every existing caller is completely unchanged.
--
-- Deliberately NOT added here: separate "collector device location" columns
-- on sample_device_context. That table is defined (0023) but is not written
-- to by ANY version of submit_sample today — there is no existing "device
-- GPS" input into this RPC at all, so there is nothing for a reported
-- coordinate to be silently replaced BY. Adding unused columns with no
-- writer would be schema surface with no real caller; flagged as a Phase 2D+
-- candidate (item M of the Phase 2C report) rather than spec'd here.

alter table enterprise.sample
  add column if not exists outside_assignment boolean;

comment on column enterprise.sample.outside_assignment is
  'NULL when not collected under an Enterprise mission. Otherwise: true if the sample''s actual GPS location fell outside the collector''s active assigned H3 cell for that mission — recorded, never blocked (H3 is a work-allocation overlay, not a geological boundary).';

alter table enterprise.sample_location
  add column if not exists location_origin text not null default 'observed'
    check (location_origin in ('observed', 'reported'));

comment on column enterprise.sample_location.location_origin is
  '''observed'' = the collector physically recorded this location themselves. ''reported'' = the coordinate came from another source/person. Never inferred or overwritten by the server — always exactly what the submitter said it was.';

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select column_name from information_schema.columns where table_schema='enterprise'
--     and table_name='sample' and column_name='outside_assignment';
--   select column_name, column_default from information_schema.columns where table_schema='enterprise'
--     and table_name='sample_location' and column_name='location_origin';

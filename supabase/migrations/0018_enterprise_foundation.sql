-- 0018_enterprise_foundation.sql
--
-- Luul Scan Enterprise — Phase 1, Sprint 1: FOUNDATION ONLY.
--
-- Additive & isolated. Creates the three enterprise schemas, enables the two
-- required extensions, and defines all 22 enum types. It creates NO tables, NO
-- RLS, NO functions, and does NOT touch the `public` (consumer) schema in any
-- way. Built to: Architecture v1.0 + A1 + A2 + A3 + Phase 1 Spec.
--
-- Idempotent: safe to run more than once (schemas/extensions use IF NOT EXISTS;
-- enum types are guarded with a duplicate_object exception).
--
-- Rollback (down-path) is documented at the bottom of this file and verified on
-- the local shadow DB. It never affects `public`.

-- ── Schemas ────────────────────────────────────────────────────────────────
create schema if not exists enterprise;
create schema if not exists geo;
create schema if not exists ml;

-- ── Extensions (only these two in Sprint 1) ────────────────────────────────
-- pgcrypto: gen_random_uuid() for UUID PKs (Sprint 2+). Already present on
-- Supabase; included for a reproducible from-scratch shadow DB.
create extension if not exists pgcrypto with schema extensions;
-- postgis: geography/geometry + GIST (used from Sprint 2). Available 3.3.x.
create extension if not exists postgis with schema extensions;

-- ── Enum types (22) — all in schema `enterprise` ───────────────────────────
-- Idempotent creation helper pattern: create inside a DO block and swallow the
-- duplicate_object error so re-running the migration is a no-op.

do $$ begin create type enterprise.area_origin as enum ('seed','user');
exception when duplicate_object then null; end $$;

do $$ begin create type enterprise.area_status as enum ('new','community','verified','archived');
exception when duplicate_object then null; end $$;

do $$ begin create type enterprise.verification_state as enum ('unverified','community_confirmed','expert_verified','lab_verified');
exception when duplicate_object then null; end $$;

do $$ begin create type enterprise.terrain_type as enum ('mountain','wadi_river','plateau','coastal','desert','outcrop','other');
exception when duplicate_object then null; end $$;

do $$ begin create type enterprise.contributor_role as enum ('normal','field_contributor','team_leader','enterprise_customer','admin');
exception when duplicate_object then null; end $$;

do $$ begin create type enterprise.project_visibility as enum ('private','team','public');
exception when duplicate_object then null; end $$;

do $$ begin create type enterprise.mission_status as enum ('planned','active','paused','completed','archived');
exception when duplicate_object then null; end $$;

do $$ begin create type enterprise.sample_status as enum ('submitted','community_confirmed','expert_verified','lab_verified','held','rejected');
exception when duplicate_object then null; end $$;

do $$ begin create type enterprise.completeness as enum ('incomplete','complete');
exception when duplicate_object then null; end $$;

do $$ begin create type enterprise.media_role as enum ('context','surface_closeup','texture_structure','key_feature','scale_reference','extra');
exception when duplicate_object then null; end $$;

do $$ begin create type enterprise.gps_source as enum ('gps','fused','network','manual');
exception when duplicate_object then null; end $$;

do $$ begin create type enterprise.obs_method as enum ('field','ai','expert');
exception when duplicate_object then null; end $$;

do $$ begin create type enterprise.evidence_type as enum ('visible_gold','historical_mining','previous_exploration','lab_assay','drill_result','gov_academic_reference','community_report');
exception when duplicate_object then null; end $$;

do $$ begin create type enterprise.review_decision as enum ('confirm','dispute','reject');
exception when duplicate_object then null; end $$;

-- A2 additions
do $$ begin create type enterprise.org_role as enum ('owner','admin','member','viewer');
exception when duplicate_object then null; end $$;

do $$ begin create type enterprise.audit_action as enum ('insert','update','delete','verify','promote','login','export');
exception when duplicate_object then null; end $$;

do $$ begin create type enterprise.finding_type as enum ('sample_collected','no_mineralization','inaccessible','other');
exception when duplicate_object then null; end $$;

do $$ begin create type enterprise.sample_method as enum ('grab','rock_chip','channel','soil','stream_sediment','float','other');
exception when duplicate_object then null; end $$;

do $$ begin create type enterprise.alteration_type as enum ('silicification','sericitic','argillic','propylitic','potassic','oxidation','carbonate','other');
exception when duplicate_object then null; end $$;

do $$ begin create type enterprise.alteration_grade as enum ('none','weak','moderate','strong','pervasive');
exception when duplicate_object then null; end $$;

do $$ begin create type enterprise.structure_type as enum ('vein','fault','fold','foliation','joint','shear','contact','bedding');
exception when duplicate_object then null; end $$;

do $$ begin create type enterprise.assignment_status as enum ('assigned','in_progress','completed','skipped','expired');
exception when duplicate_object then null; end $$;

-- ── ROLLBACK (down-path) — run manually on the shadow DB to verify ─────────
-- Additive & isolated, so the full down-path is a clean schema drop. It never
-- touches `public`. pgcrypto is left in place (shared, pre-existing on Supabase).
--
--   drop schema if exists enterprise cascade;
--   drop schema if exists geo cascade;
--   drop schema if exists ml cascade;
--   -- optionally: drop extension if exists postgis;   -- only if nothing else uses it
--
-- (Dropping schema enterprise cascade also removes all 22 enum types defined in it.)

-- Dual Explanation Modes (Simple & Expert) — see 03-AI-Architecture-and-Data-Sources.md.
--
-- Purely additive: no new tables, no RLS policy changes. The rich Simple/Expert
-- explanation text itself lives inside the existing `scans.final_result` jsonb
-- blob (alongside `reasoning`/`alternatives`, already unstructured JSON) and the
-- per-provider structured analysis lives inside the new `scan_ai_responses.analysis`
-- jsonb column — both covered by the select-own / service-role-only policies that
-- already exist on those tables.

-- The user's remembered explanation-style preference, mirroring `profiles.locale`.
alter table public.profiles
  add column if not exists explanation_style text
    check (explanation_style is null or explanation_style in ('simple', 'expert'))
    default 'simple';

-- Which style was requested for THIS scan (nullable — legacy scans predate the
-- feature and simply have no value here), mirroring `scans.specimen_category`.
alter table public.scans
  add column if not exists explanation_style text
    check (explanation_style is null or explanation_style in ('simple', 'expert'));

-- Structured per-provider gemological analysis (species, hardness, RI, market
-- notes, etc.) backing the Simple/Expert explanations, kept alongside the
-- existing free-text `reasoning` and full `raw_response` for the same audit
-- trail purpose. service_role-only, same as every other column on this table.
alter table public.scan_ai_responses
  add column if not exists analysis jsonb;

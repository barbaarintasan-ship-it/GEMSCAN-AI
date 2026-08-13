-- 0101_mission_analysis.sql
--
-- Where a field mission's assessment is written down.
--
-- WHY THE TABLE FROM 0099 COULD NOT BE USED AS IT STOOD
-- ----------------------------------------------------
-- `geo.mission_report` was designed around prose: `interpretation text not null`,
-- `evidence_summary text not null`. The analysis this project actually produces is
-- `MissionFindings` (shared/geo-core/gie/missionFindings.ts) — a set of CODES with
-- no prose in it at all, rendered into Somali or English on demand by
-- renderReport() with no model call and no possibility of the two languages
-- disagreeing about the geology.
--
-- Storing that in a not-null prose column would have forced the writer to invent
-- sentences at insert time, which is the exact thing the design exists to prevent.
-- So `findings jsonb` becomes the record, and the flat columns become a nullable
-- projection for querying.
--
-- The table is EMPTY in production — it has never had a writer — so this is safe.
--
-- WHAT THIS TABLE STILL CANNOT HOLD
-- ---------------------------------
-- There is no probability column and no "confirmed" column, and now a CHECK that
-- refuses a findings document containing one. Three layers say the same thing: the
-- TypeScript type makes it unrepresentable, withoutForbiddenNarrative() strips it
-- from prose in both languages, and this constraint refuses it at the database.
-- The first two are conventions inside one codebase; this one is enforcement.
--
-- Idempotent (IF NOT EXISTS / OR REPLACE); documented rollback.
-- Depends on: 0099 (field_mission, mission_package, mission_report).

-- ── The findings themselves ─────────────────────────────────────────────────
alter table geo.mission_report
  add column if not exists findings jsonb,
  -- The model's reading before the evidence ceiling was applied, kept when the two
  -- differ. A model that reported HIGH on two observations and no assay has told
  -- you something about itself, and capping without recording destroys that.
  add column if not exists claimed_confidence text,
  add column if not exists interest text,
  -- Which languages the narrative was produced in, e.g. {en,so}. NOT a rendering
  -- setting: renderReport() draws either language from the codes on demand, and a
  -- stored "report language" would be a second source of truth able to disagree
  -- with what the reader actually picked.
  add column if not exists analysis_language text[] not null default '{}';

-- The prose columns stop being required. They are a projection now, not the record.
alter table geo.mission_report alter column interpretation   drop not null;
alter table geo.mission_report alter column evidence_summary drop not null;

do $$ begin
  alter table geo.mission_report
    add constraint ck_mission_report_no_probability
    check (findings is null or not (findings ? 'probability'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table geo.mission_report
    add constraint ck_mission_report_has_confidence
    check (findings is null or findings ? 'confidence');
exception when duplicate_object then null; end $$;

-- ── Why an analysis did not happen ──────────────────────────────────────────
-- A mission that failed analysis and a mission nobody has analysed yet look
-- identical without this, and the difference is whether anyone should retry.
alter table geo.field_mission
  add column if not exists analysis_error text,
  add column if not exists analysis_attempts integer not null default 0,
  add column if not exists last_analysis_at timestamptz;

-- ── Save ────────────────────────────────────────────────────────────────────
-- One call, one transaction: the report and the mission's state move together. A
-- mission reading `ai_analysis_complete` with no report behind it would be worse
-- than one that never got there.
--
-- The flat columns are filled FROM the findings, never independently — two writers
-- for one fact is how a report ends up disagreeing with itself.
create or replace function geo.save_mission_report(
  p_actor uuid,
  p_mission text,
  p_package text,
  p_findings jsonb
) returns uuid
language plpgsql
security definer
set search_path = geo, public
as $$
declare
  v_id uuid;
  v_langs text[];
begin
  if p_findings is null or not (p_findings ? 'confidence') then
    raise exception 'findings must carry a confidence' using errcode = 'invalid_parameter_value';
  end if;
  -- Refused here as well as by the constraint, so the caller gets a sentence
  -- naming the problem rather than a constraint violation naming a table.
  if p_findings ? 'probability' then
    raise exception 'findings may not contain a probability' using errcode = 'invalid_parameter_value';
  end if;

  -- The mission must belong to the actor. Mission ids are generated on the device
  -- and are guessable, so ownership is checked in the write, not before it.
  if not exists (
    select 1 from geo.field_mission
     where id = p_mission and user_id = p_actor
  ) then
    raise exception 'mission % not found for actor', p_mission using errcode = 'no_data_found';
  end if;

  select coalesce(array_agg(k order by k), '{}')
    into v_langs
    from jsonb_object_keys(coalesce(p_findings->'narrative', '{}'::jsonb)) as k;

  insert into geo.mission_report (
    mission_id, package_id, user_id, findings,
    interest, confidence, claimed_confidence, analysis_language,
    missing_evidence, model
  ) values (
    p_mission, p_package, p_actor, p_findings,
    p_findings->>'interest',
    p_findings->>'confidence',
    p_findings->>'claimedConfidence',
    v_langs,
    coalesce((
      select array_agg(value #>> '{}')
        from jsonb_array_elements(coalesce(p_findings->'missingEvidence', '[]'::jsonb))
    ), '{}'),
    p_findings->>'model'
  )
  returning id into v_id;

  update geo.field_mission
     set state = 'ai_analysis_complete',
         analysis_error = null,
         last_analysis_at = now(),
         updated_at = now()
   where id = p_mission;

  return v_id;
end;
$$;

-- ── Fail ────────────────────────────────────────────────────────────────────
-- A failed analysis RECORDS why and leaves every byte of evidence untouched. The
-- package, its photographs and its rows are exactly as they were; only the mission
-- carries the fact that a reading was attempted and did not come back.
--
-- Attempts are counted so a mission failing for ever is visible as such, rather
-- than looking like one that has simply not been analysed yet.
create or replace function geo.fail_mission_analysis(
  p_actor uuid,
  p_mission text,
  p_reason text
) returns integer
language plpgsql
security definer
set search_path = geo, public
as $$
declare v_attempts integer;
begin
  update geo.field_mission
     set state = 'failed',
         analysis_error = left(coalesce(p_reason, 'unknown'), 500),
         analysis_attempts = analysis_attempts + 1,
         last_analysis_at = now(),
         updated_at = now()
   where id = p_mission and user_id = p_actor
  returning analysis_attempts into v_attempts;

  if v_attempts is null then
    raise exception 'mission % not found for actor', p_mission using errcode = 'no_data_found';
  end if;
  return v_attempts;
end;
$$;

revoke all on function geo.save_mission_report(uuid, text, text, jsonb) from public;
revoke all on function geo.fail_mission_analysis(uuid, text, text) from public;
grant execute on function geo.save_mission_report(uuid, text, text, jsonb) to service_role;
grant execute on function geo.fail_mission_analysis(uuid, text, text) to service_role;

-- ── VERIFY (CI/CD) — expect columns=4, functions=2, constraints=2 ──────────
--   select
--     (select count(*) from information_schema.columns where table_schema='geo'
--        and table_name='mission_report'
--        and column_name in ('findings','claimed_confidence','interest','analysis_language')) as columns,
--     (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--        where n.nspname='geo' and p.proname in
--        ('save_mission_report','fail_mission_analysis')) as functions,
--     (select count(*) from pg_constraint where conname in
--        ('ck_mission_report_no_probability','ck_mission_report_has_confidence')) as constraints;

-- ── ROLLBACK (down-path) ───────────────────────────────────────────────────
--   drop function if exists geo.fail_mission_analysis(uuid, text, text);
--   drop function if exists geo.save_mission_report(uuid, text, text, jsonb);
--   alter table geo.field_mission drop column if exists last_analysis_at;
--   alter table geo.field_mission drop column if exists analysis_attempts;
--   alter table geo.field_mission drop column if exists analysis_error;
--   alter table geo.mission_report drop constraint if exists ck_mission_report_has_confidence;
--   alter table geo.mission_report drop constraint if exists ck_mission_report_no_probability;
--   alter table geo.mission_report drop column if exists analysis_language;
--   alter table geo.mission_report drop column if exists interest;
--   alter table geo.mission_report drop column if exists claimed_confidence;
--   alter table geo.mission_report drop column if exists findings;
--   -- NOTE: the NOT NULLs on interpretation/evidence_summary are NOT restored.
--   -- Doing so would fail against any row this migration allowed to be written.

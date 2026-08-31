-- 0108_integrated_prospectivity.sql
--
-- A queryable projection of the Integrated Prospectivity Score (Architecture:
-- Integrated Prospectivity Score, Stage 5).
--
-- ZERO MIGRATION WAS NEEDED TO STORE THE NUMBER ITSELF
-- ------------------------------------------------------
-- `geo.mission_report.findings` is JSONB and already stores `MissionFindings`
-- verbatim (0101_mission_analysis.sql) — the additive `integratedProspectivity`
-- field the server now writes (analyzeMission.ts, Stage 4) lands inside it with
-- no schema change at all, and `geo.mission_package.payload` — also JSONB,
-- storing the device's package verbatim — already carries the client's own
-- `integratedProspectivityScore`/`structuredEvidence`/`integratedEvidenceItems`
-- the same way. This migration is not about capture; it is about being able to
-- ask a question like "how many missions cleared 0.7" without a JSONB path
-- expression in every query.
--
-- So this does exactly what 0101 already did for `interest`/`confidence`: add
-- ONE flat, nullable projection column, filled FROM `findings` inside
-- `save_mission_report()`, never independently — two writers for one fact is
-- how a report ends up disagreeing with itself.
--
-- NOT A SECOND SCORE. `mission_report` already has no probability column and a
-- constraint refusing one; this adds a NUMBER that is exactly as much "not a
-- probability" as `prospectivityScore` already is — same rule, restated. It
-- sits beside `confidence`/`interest`, not in place of anything.
--
-- Idempotent (IF NOT EXISTS / OR REPLACE); documented rollback.
-- Depends on: 0101 (mission_report.findings, save_mission_report).

alter table geo.mission_report
  add column if not exists integrated_prospectivity numeric;

do $$ begin
  alter table geo.mission_report
    add constraint ck_mission_report_integrated_range
    check (integrated_prospectivity is null
           or (integrated_prospectivity >= 0 and integrated_prospectivity <= 1));
exception when duplicate_object then null; end $$;

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
    missing_evidence, model, integrated_prospectivity
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
    p_findings->>'model',
    -- NULL when absent, exactly as the type intends — an absent number, never
    -- a coerced zero. `(text)::numeric` on a genuinely missing key is NULL,
    -- not an error: `->>'integratedProspectivity'` returns SQL NULL when the
    -- key is not present, and NULL::numeric stays NULL.
    (p_findings->>'integratedProspectivity')::numeric
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

revoke all on function geo.save_mission_report(uuid, text, text, jsonb) from public;
grant execute on function geo.save_mission_report(uuid, text, text, jsonb) to service_role;

-- ── VERIFY (CI/CD) — expect columns=1, constraints=1 ────────────────────────
--   select
--     (select count(*) from information_schema.columns where table_schema='geo'
--        and table_name='mission_report' and column_name='integrated_prospectivity') as columns,
--     (select count(*) from pg_constraint where conname='ck_mission_report_integrated_range') as constraints;

-- ── ROLLBACK (down-path) ───────────────────────────────────────────────────
-- The function is restored to 0101's body FIRST — it must never reference a
-- column that is about to be dropped — and only then is the column removed.
--   create or replace function geo.save_mission_report(
--     p_actor uuid, p_mission text, p_package text, p_findings jsonb
--   ) returns uuid language plpgsql security definer set search_path = geo, public as $f$
--   declare v_id uuid; v_langs text[];
--   begin
--     if p_findings is null or not (p_findings ? 'confidence') then
--       raise exception 'findings must carry a confidence' using errcode = 'invalid_parameter_value';
--     end if;
--     if p_findings ? 'probability' then
--       raise exception 'findings may not contain a probability' using errcode = 'invalid_parameter_value';
--     end if;
--     if not exists (select 1 from geo.field_mission where id = p_mission and user_id = p_actor) then
--       raise exception 'mission % not found for actor', p_mission using errcode = 'no_data_found';
--     end if;
--     select coalesce(array_agg(k order by k), '{}') into v_langs
--       from jsonb_object_keys(coalesce(p_findings->'narrative', '{}'::jsonb)) as k;
--     insert into geo.mission_report (
--       mission_id, package_id, user_id, findings,
--       interest, confidence, claimed_confidence, analysis_language, missing_evidence, model
--     ) values (
--       p_mission, p_package, p_actor, p_findings,
--       p_findings->>'interest', p_findings->>'confidence', p_findings->>'claimedConfidence', v_langs,
--       coalesce((select array_agg(value #>> '{}')
--         from jsonb_array_elements(coalesce(p_findings->'missingEvidence', '[]'::jsonb))), '{}'),
--       p_findings->>'model'
--     ) returning id into v_id;
--     update geo.field_mission set state = 'ai_analysis_complete', analysis_error = null,
--       last_analysis_at = now(), updated_at = now() where id = p_mission;
--     return v_id;
--   end; $f$;
--   alter table geo.mission_report drop constraint if exists ck_mission_report_integrated_range;
--   alter table geo.mission_report drop column if exists integrated_prospectivity;

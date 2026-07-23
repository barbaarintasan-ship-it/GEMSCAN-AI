-- 0037_sample_policies.sql
--
-- Luul Scan Enterprise — Phase 1, Sprint 3 (5/N, SECURITY): read policies for
-- sample + sample_location + sample_media + sample_device_context + the four
-- observation tables + the two survey tables. WRITES on all of these are
-- SERVICE-ROLE-ONLY (no write grant / no write policy for authenticated).
--
-- Security only (SELECT policies + read grants + 2 companion helpers) — NO
-- schema DDL. occurrence_evidence / verification policies are 0038. Frozen
-- schema (0018-0032), public/consumer, production untouched.
--
-- Principle enforced here (foundation for Collector != Verifier): the sample
-- owner can READ their sample but cannot mutate it — status/verification changes
-- flow only through the service role (Edge Functions, Sprint 5). So an owner can
-- never self-confirm or verify their own sample.
--
-- Recursion safety: helpers are SECURITY DEFINER (bypass RLS). Idempotent.

-- ── Companion helpers ──────────────────────────────────────────────────────
-- Can the caller read this area at all? community (project_id null) => any
-- authenticated; private => members of the owning project's org.
create or replace function enterprise.can_read_area(p_area uuid)
returns boolean
language sql stable security definer
set search_path = enterprise, pg_temp
as $$
  select exists (
    select 1 from enterprise.exploration_area a
    where a.id = p_area
      and (a.project_id is null or enterprise.is_project_member(a.project_id))
  );
$$;

-- Can the caller read this sample? owner always; otherwise only when the sample
-- is community_confirmed+ AND its area is readable.
create or replace function enterprise.can_read_sample(p_sample uuid)
returns boolean
language sql stable security definer
set search_path = enterprise, pg_temp
as $$
  select exists (
    select 1 from enterprise.sample s
    where s.id = p_sample
      and (
        s.collector_id = auth.uid()
        or (s.status in ('community_confirmed','expert_verified','lab_verified')
            and enterprise.can_read_area(s.area_id))
      )
  );
$$;

grant execute on function enterprise.can_read_area(uuid)   to authenticated, service_role;
grant execute on function enterprise.can_read_sample(uuid) to authenticated, service_role;

-- ── Grants: authenticated = SELECT only; service_role = full (writes) ──────
grant select on
  enterprise.sample, enterprise.sample_location, enterprise.sample_media,
  enterprise.sample_device_context, enterprise.rock_observation,
  enterprise.mineral_observation, enterprise.alteration_observation,
  enterprise.structural_measurement, enterprise.survey_track,
  enterprise.field_observation_point
  to authenticated;
grant select, insert, update, delete on
  enterprise.sample, enterprise.sample_location, enterprise.sample_media,
  enterprise.sample_device_context, enterprise.rock_observation,
  enterprise.mineral_observation, enterprise.alteration_observation,
  enterprise.structural_measurement, enterprise.survey_track,
  enterprise.field_observation_point
  to service_role;

-- ── SELECT policies (writes intentionally have NO authenticated policy) ─────
drop policy if exists sample_select on enterprise.sample;
create policy sample_select on enterprise.sample for select to authenticated
  using (collector_id = auth.uid()
         or (status in ('community_confirmed','expert_verified','lab_verified')
             and enterprise.can_read_area(area_id)));

drop policy if exists sample_location_select on enterprise.sample_location;
create policy sample_location_select on enterprise.sample_location for select to authenticated
  using (enterprise.can_read_sample(sample_id));

drop policy if exists sample_media_select on enterprise.sample_media;
create policy sample_media_select on enterprise.sample_media for select to authenticated
  using (enterprise.can_read_sample(sample_id));

drop policy if exists sample_device_context_select on enterprise.sample_device_context;
create policy sample_device_context_select on enterprise.sample_device_context for select to authenticated
  using (enterprise.can_read_sample(sample_id));

drop policy if exists rock_obs_select on enterprise.rock_observation;
create policy rock_obs_select on enterprise.rock_observation for select to authenticated
  using (enterprise.can_read_sample(sample_id));

drop policy if exists mineral_obs_select on enterprise.mineral_observation;
create policy mineral_obs_select on enterprise.mineral_observation for select to authenticated
  using (enterprise.can_read_sample(sample_id));

drop policy if exists alteration_obs_select on enterprise.alteration_observation;
create policy alteration_obs_select on enterprise.alteration_observation for select to authenticated
  using (enterprise.can_read_sample(sample_id));

drop policy if exists structural_select on enterprise.structural_measurement;
create policy structural_select on enterprise.structural_measurement for select to authenticated
  using (enterprise.can_read_sample(sample_id));

drop policy if exists survey_track_select on enterprise.survey_track;
create policy survey_track_select on enterprise.survey_track for select to authenticated
  using (contributor_id = auth.uid() or enterprise.can_read_area(area_id));

drop policy if exists fop_select on enterprise.field_observation_point;
create policy fop_select on enterprise.field_observation_point for select to authenticated
  using (contributor_id = auth.uid() or enterprise.can_read_area(area_id));

-- ── VERIFY (CI/CD) — expect: select_policies=10, write_policies=0, helpers=2, auth_insert_on_sample=0 ──
--   select
--     (select count(*) from pg_policies where schemaname='enterprise' and cmd='SELECT'
--        and tablename in ('sample','sample_location','sample_media','sample_device_context',
--          'rock_observation','mineral_observation','alteration_observation','structural_measurement',
--          'survey_track','field_observation_point')) as select_policies,
--     (select count(*) from pg_policies where schemaname='enterprise' and cmd in ('INSERT','UPDATE','DELETE','ALL')
--        and tablename in ('sample','sample_location','sample_media','sample_device_context',
--          'rock_observation','mineral_observation','alteration_observation','structural_measurement',
--          'survey_track','field_observation_point')) as write_policies,   -- expect 0 (service-only writes)
--     (select count(*) from pg_proc p join pg_namespace n on p.pronamespace=n.oid
--        where n.nspname='enterprise' and p.proname in ('can_read_area','can_read_sample')) as helpers,
--     (select count(*) from information_schema.role_table_grants where grantee='authenticated'
--        and table_schema='enterprise' and table_name='sample' and privilege_type='INSERT') as auth_insert_on_sample; -- expect 0

-- ── ROLLBACK (down-path) — drop policies, revoke grants, drop helpers ──────
--   drop policy if exists fop_select on enterprise.field_observation_point;
--   drop policy if exists survey_track_select on enterprise.survey_track;
--   drop policy if exists structural_select on enterprise.structural_measurement;
--   drop policy if exists alteration_obs_select on enterprise.alteration_observation;
--   drop policy if exists mineral_obs_select on enterprise.mineral_observation;
--   drop policy if exists rock_obs_select on enterprise.rock_observation;
--   drop policy if exists sample_device_context_select on enterprise.sample_device_context;
--   drop policy if exists sample_media_select on enterprise.sample_media;
--   drop policy if exists sample_location_select on enterprise.sample_location;
--   drop policy if exists sample_select on enterprise.sample;
--   revoke select, insert, update, delete on enterprise.sample, enterprise.sample_location,
--     enterprise.sample_media, enterprise.sample_device_context, enterprise.rock_observation,
--     enterprise.mineral_observation, enterprise.alteration_observation, enterprise.structural_measurement,
--     enterprise.survey_track, enterprise.field_observation_point from authenticated, service_role;
--   drop function if exists enterprise.can_read_sample(uuid);
--   drop function if exists enterprise.can_read_area(uuid);

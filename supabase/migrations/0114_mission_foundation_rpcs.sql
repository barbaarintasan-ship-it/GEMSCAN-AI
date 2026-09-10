-- 0114_mission_foundation_rpcs.sql
--
-- Phase 2A — Mission Foundation. The ONLY writers `enterprise.exploration_mission`
-- and `enterprise.mission_contributor` have ever had (0041's own comment: "ALL
-- mission writes are SERVICE-ROLE-ONLY (mission lifecycle via the Edge Functions
-- in Sprint 5)" — Sprint 5 was never built; these tables have been schema-only
-- since 0022/0041).
--
-- Pattern: SECURITY DEFINER RPCs using auth.uid() internally, granted directly
-- to `authenticated` — the same shape as enterprise.add_org_member_by_email /
-- enterprise.org_role_of, NOT the p_actor-from-Edge-Function shape used by
-- review_sample (that one needs multi-table notification/event orchestration
-- this does not). No new role vocabulary: authorization reuses the EXACT
-- predicate project_update already uses (0035) — a personal project's own
-- owner, or an org-scoped project's org owner/admin. Returns scalar/void only
-- (no RETURNS TABLE) — a prior RPC in this same feature
-- (add_org_member_by_email, migration 0112) shipped broken in production
-- because RETURNS TABLE(user_id, email, role) created PL/pgSQL OUT-parameter
-- variables that collided with real column names of the same name used
-- inside the function body ("column reference \"user_id\" is ambiguous").
-- Avoiding RETURNS TABLE here sidesteps that whole bug class.

-- ── create_mission(): a project manager opens a new exploration campaign ────
create function enterprise.create_mission(
  p_project_id uuid,
  p_name text,
  p_description text default null,
  p_target_observation_count integer default 0,
  p_target_coverage_pct numeric default 0
)
returns uuid
language plpgsql
security definer
set search_path = enterprise, pg_temp
as $$
declare
  v_org        uuid;
  v_owner      uuid;
  v_mission_id uuid;
begin
  select organization_id, owner_id into v_org, v_owner
    from enterprise.project where id = p_project_id;
  if not found then
    raise exception 'validation: project not found';
  end if;

  -- Same boundary as project_update (0035) — no new "manager" concept.
  if not (
    (v_org is null and v_owner = auth.uid())
    or (v_org is not null and enterprise.org_role_of(v_org) in ('owner', 'admin'))
  ) then
    raise exception 'forbidden: only the project owner or an org owner/admin can create a mission';
  end if;

  if p_name is null or trim(p_name) = '' then
    raise exception 'validation: mission name is required';
  end if;
  if p_target_observation_count is not null and p_target_observation_count < 0 then
    raise exception 'validation: target_observation_count must not be negative';
  end if;
  if p_target_coverage_pct is not null and (p_target_coverage_pct < 0 or p_target_coverage_pct > 100) then
    raise exception 'validation: target_coverage_pct must be between 0 and 100';
  end if;

  insert into enterprise.exploration_mission
    (name, description, owner_id, project_id, target_observation_count, target_coverage_pct, created_by)
  values
    (trim(p_name), nullif(trim(coalesce(p_description, '')), ''), auth.uid(), p_project_id,
     coalesce(p_target_observation_count, 0), coalesce(p_target_coverage_pct, 0), auth.uid())
  returning id into v_mission_id;

  -- The creating manager is automatically on the roster as team_leader — they
  -- created it, they lead it; more contributors are added separately below.
  insert into enterprise.mission_contributor (mission_id, contributor_id, role)
  values (v_mission_id, auth.uid(), 'team_leader')
  on conflict (mission_id, contributor_id) do nothing;

  insert into enterprise.audit_log (actor_id, action, entity_type, entity_id, after, context)
  values (auth.uid(), 'mission_create', 'exploration_mission', v_mission_id,
    jsonb_build_object('name', trim(p_name), 'project_id', p_project_id),
    jsonb_build_object('source', 'enterprise.create_mission'));

  return v_mission_id;
end;
$$;
grant execute on function enterprise.create_mission(uuid, text, text, integer, numeric) to authenticated;

-- ── add_mission_contributor(): roster management, by email ──────────────────
-- Mirrors enterprise.add_org_member_by_email's shape/UX (email, not a UUID the
-- client would have no way to know). For an org-scoped project's mission, the
-- target must ALREADY be a member of that org — a mission roster cannot be
-- used to route around organization tenancy boundaries.
create function enterprise.add_mission_contributor(
  p_mission uuid,
  p_email text,
  p_role enterprise.contributor_role default 'field_contributor'
)
returns void
language plpgsql
security definer
set search_path = enterprise, auth, pg_temp
as $$
declare
  v_mission_owner uuid;
  v_project_id    uuid;
  v_org           uuid;
  v_project_owner uuid;
  v_target        uuid;
  v_email         text := lower(trim(p_email));
begin
  select owner_id, project_id into v_mission_owner, v_project_id
    from enterprise.exploration_mission where id = p_mission;
  if not found then
    raise exception 'validation: mission not found';
  end if;

  select organization_id, owner_id into v_org, v_project_owner
    from enterprise.project where id = v_project_id;

  if not (
    v_mission_owner = auth.uid()
    or (v_org is null and v_project_owner = auth.uid())
    or (v_org is not null and enterprise.org_role_of(v_org) in ('owner', 'admin'))
  ) then
    raise exception 'forbidden: only the mission owner or an org owner/admin can manage the roster';
  end if;

  if v_email = '' or v_email is null then
    raise exception 'validation: email is required';
  end if;

  select u.id into v_target from auth.users u where lower(u.email) = v_email limit 1;
  if v_target is null then
    raise exception 'no_account: no GEMSCAN account exists for %; ask them to sign up first, then try again', p_email;
  end if;

  -- Organization tenancy boundary: an org-scoped mission may only roster
  -- people who already belong to that org (adding to a mission is not a
  -- backdoor into the organization itself).
  if v_org is not null and not exists (
    select 1 from enterprise.organization_member where organization_id = v_org and user_id = v_target
  ) then
    raise exception 'not_org_member: this person must already belong to the mission''s organization';
  end if;

  -- Idempotent + safe re-add: upserts the role rather than erroring, so
  -- calling this twice (retry, or promoting someone's mission role later)
  -- never fails.
  insert into enterprise.mission_contributor (mission_id, contributor_id, role)
  values (p_mission, v_target, p_role)
  on conflict (mission_id, contributor_id) do update set role = excluded.role;

  insert into enterprise.audit_log (actor_id, action, entity_type, entity_id, after, context)
  values (auth.uid(), 'mission_add_contributor', 'exploration_mission', p_mission,
    jsonb_build_object('contributor_id', v_target, 'role', p_role),
    jsonb_build_object('source', 'enterprise.add_mission_contributor'));
end;
$$;
grant execute on function enterprise.add_mission_contributor(uuid, text, enterprise.contributor_role) to authenticated;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select proname from pg_proc p join pg_namespace n on p.pronamespace = n.oid
--     where n.nspname = 'enterprise' and proname in ('create_mission', 'add_mission_contributor');

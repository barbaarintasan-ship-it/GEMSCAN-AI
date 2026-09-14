-- 0134_followup_mission.sql
--
-- Phase 9 (Solo→Team shared-targeting) — a follow-up mission. When a mission
-- has run its course, its best-scoring cell is often exactly where the NEXT
-- mission should start — a tighter, more focused sweep of the ground that
-- already showed the strongest deterministic signal. This adds mission-level
-- provenance (mirroring exploration_area.source_target_h3/source_target_score,
-- 0116) and a single RPC that creates the new mission AND its starting area
-- from the source mission's best cell, atomically, the SAME way
-- create_mission_area_from_target (Phase 2) creates an area from an accepted
-- recommendation.
--
-- WHOSE score: prospectivity_score (Phase 3), never integrated_score
-- (Phase 8) — ranking/"best cell" always reads the validated baseline, per
-- that phase's own invariant that the integrated number is informational
-- only and never drives ranking decisions.

alter table enterprise.exploration_mission
  add column if not exists source_mission_id uuid references enterprise.exploration_mission(id) on delete set null,
  add column if not exists source_target_h3 text,
  add column if not exists source_score numeric;

comment on column enterprise.exploration_mission.source_mission_id is
  'Phase 9 — the completed mission this one follows up on, if any. NULL for a mission started from scratch.';

create index if not exists idx_exploration_mission_source on enterprise.exploration_mission (source_mission_id) where source_mission_id is not null;

create or replace function enterprise.create_followup_mission(
  p_source_mission uuid,
  p_name text,
  p_description text,
  p_target_h3 text,
  p_target_score numeric,
  p_center_lat double precision,
  p_center_lng double precision,
  p_boundary_geojson text,
  p_envelope_rings int,
  p_commodity text default null
)
returns jsonb
language plpgsql
security definer
set search_path = enterprise, extensions, pg_temp
as $$
declare
  v_project_id uuid;
  v_mission_id uuid;
  v_area_id uuid;
  v_center extensions.geography;
  v_boundary extensions.geography;
  v_geom_type text;
begin
  if not enterprise.is_mission_manager(p_source_mission) then
    raise exception 'forbidden: only the source mission''s owner or an org owner/admin can create a follow-up mission';
  end if;

  if p_target_h3 is null or p_target_h3 !~ '^[0-9a-f]{15}$' then
    raise exception 'validation: % is not a well-formed H3 cell index', p_target_h3;
  end if;
  if p_target_score is null or p_target_score < 0 or p_target_score > 1 then
    raise exception 'validation: target_score must be a number between 0 and 1';
  end if;
  if btrim(coalesce(p_name, '')) = '' then
    raise exception 'validation: mission name is required';
  end if;
  if p_center_lat is null or p_center_lng is null
     or p_center_lat < -90 or p_center_lat > 90 or p_center_lng < -180 or p_center_lng > 180 then
    raise exception 'validation: center lat/lng out of range';
  end if;

  select project_id into v_project_id from enterprise.exploration_mission where id = p_source_mission;
  if v_project_id is null then
    raise exception 'validation: source mission % has no project to attribute the follow-up to', p_source_mission;
  end if;

  -- Never trust a client-supplied (target_h3, score) pair blindly — it must
  -- match an actual scored cell of the SOURCE mission, the same discipline
  -- create_mission_area_from_target's own header established for accepted
  -- recommendations.
  if not exists (
    select 1 from enterprise.mission_assignment ma
    where ma.mission_id = p_source_mission and ma.target_h3 = p_target_h3
      and ma.contributor_id is null and ma.prospectivity_score = p_target_score
  ) then
    raise exception 'validation: target_h3/target_score do not match a scored cell of the source mission';
  end if;

  insert into enterprise.exploration_mission
    (name, description, owner_id, project_id, created_by, source_mission_id, source_target_h3, source_score)
  values
    (btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''), auth.uid(), v_project_id, auth.uid(),
     p_source_mission, p_target_h3, p_target_score)
  returning id into v_mission_id;

  insert into enterprise.mission_contributor (mission_id, contributor_id, role)
  values (v_mission_id, auth.uid(), 'team_leader')
  on conflict (mission_id, contributor_id) do nothing;

  v_center := extensions.ST_SetSRID(extensions.ST_MakePoint(p_center_lng, p_center_lat), 4326)::extensions.geography;
  begin
    v_boundary := extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON(p_boundary_geojson), 4326)::extensions.geography;
  exception when others then
    raise exception 'validation: boundary is not valid GeoJSON';
  end;
  v_geom_type := extensions.GeometryType(v_boundary::extensions.geometry);
  if v_geom_type not in ('MULTIPOLYGON', 'POLYGON') then
    raise exception 'validation: boundary must be a polygon or multipolygon, got %', v_geom_type;
  end if;

  insert into enterprise.exploration_area (
    name, origin, creator_id, project_id, center, boundary,
    source_target_h3, source_target_score, source_commodity, source_envelope_rings,
    created_by
  ) values (
    btrim(p_name), 'ai_recommended', auth.uid(), v_project_id, v_center, v_boundary,
    p_target_h3, p_target_score, p_commodity, p_envelope_rings,
    auth.uid()
  ) returning id into v_area_id;

  insert into enterprise.mission_area (mission_id, area_id) values (v_mission_id, v_area_id);

  insert into enterprise.audit_log (actor_id, action, entity_type, entity_id, after, context)
  values (auth.uid(), 'mission_create', 'exploration_mission', v_mission_id,
    jsonb_build_object('name', btrim(p_name), 'project_id', v_project_id,
      'source_mission_id', p_source_mission, 'source_target_h3', p_target_h3, 'source_score', p_target_score),
    jsonb_build_object('source', 'enterprise.create_followup_mission'));

  return jsonb_build_object('mission_id', v_mission_id, 'area_id', v_area_id);
end;
$$;
grant execute on function enterprise.create_followup_mission(
  uuid, text, text, text, numeric, double precision, double precision, text, int, text
) to authenticated;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select has_function_privilege('authenticated',
--     'enterprise.create_followup_mission(uuid,text,text,text,numeric,double precision,double precision,text,int,text)',
--     'execute');

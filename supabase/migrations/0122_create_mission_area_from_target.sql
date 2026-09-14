-- 0122_create_mission_area_from_target.sql
--
-- Phase 2 — the "manager accepts an AI-recommended target" write path.
--
-- SERVER-AUTHORITATIVE, BY DESIGN. This RPC does not decide whether p_score
-- is correct — that already happened before this call, in
-- accept-recommended-area/handler.ts, which recomputes the score itself via
-- the SAME shared TargetingEngine.targetAt() Phase 1 built, from the H3
-- cell's own geometry (never from anything the client typed). By the time
-- p_target_score reaches this function it is already a server-computed
-- number; this function's job is only to validate its SHAPE (0..1) and
-- persist it, not to re-derive it a second time (that would duplicate the
-- targeting engine inside SQL, which the architecture explicitly forbids).
-- Likewise p_boundary_geojson is built server-side from p_target_h3's own
-- k-ring via h3-js — never an arbitrary polygon a client could submit to
-- claim any shape or location.
--
-- Reuses the Phase 2A/2B manager boundary (is_mission_manager, 0116)
-- unchanged — same authorization every other mission-mutating RPC uses.

create or replace function enterprise.create_mission_area_from_target(
  p_mission uuid,
  p_name text,
  p_center_lat double precision,
  p_center_lng double precision,
  p_boundary_geojson text,
  p_target_h3 text,
  p_target_score numeric,
  p_commodity text default null,
  p_envelope_rings integer default null
)
returns uuid
language plpgsql
security definer
set search_path = enterprise, extensions, pg_temp
as $$
declare
  v_project_id uuid;
  v_area_id uuid;
  v_center extensions.geography;
  v_boundary extensions.geography;
  v_geom_type text;
begin
  if not enterprise.is_mission_manager(p_mission) then
    raise exception 'forbidden: only the mission owner or an org owner/admin can create an area for this mission';
  end if;

  if p_target_h3 is null or p_target_h3 !~ '^[0-9a-f]{15}$' then
    raise exception 'validation: % is not a well-formed H3 cell index', p_target_h3;
  end if;
  if p_target_score is null or p_target_score < 0 or p_target_score > 1 then
    raise exception 'validation: target_score must be a number between 0 and 1';
  end if;
  if btrim(coalesce(p_name, '')) = '' then
    raise exception 'validation: area name is required';
  end if;
  if p_center_lat is null or p_center_lng is null
     or p_center_lat < -90 or p_center_lat > 90 or p_center_lng < -180 or p_center_lng > 180 then
    raise exception 'validation: center lat/lng out of range';
  end if;

  select project_id into v_project_id from enterprise.exploration_mission where id = p_mission;
  if v_project_id is null then
    raise exception 'validation: mission % has no project to attribute the area to', p_mission;
  end if;

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

  insert into enterprise.mission_area (mission_id, area_id) values (p_mission, v_area_id);

  insert into enterprise.audit_log (actor_id, action, entity_type, entity_id, after, context)
  values (auth.uid(), 'mission_create_area', 'exploration_area', v_area_id,
    jsonb_build_object('mission_id', p_mission, 'name', btrim(p_name),
      'source_target_h3', p_target_h3, 'source_target_score', p_target_score,
      'source_commodity', p_commodity, 'source_envelope_rings', p_envelope_rings),
    jsonb_build_object('source', 'enterprise.create_mission_area_from_target'));

  return v_area_id;
end;
$$;
grant execute on function enterprise.create_mission_area_from_target(
  uuid, text, double precision, double precision, text, text, numeric, text, integer
) to authenticated;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select has_function_privilege('authenticated',
--     'enterprise.create_mission_area_from_target(uuid,text,double precision,double precision,text,text,numeric,text,integer)',
--     'execute');

-- ── ROLLBACK (down-path) ────────────────────────────────────────────────────
--   drop function if exists enterprise.create_mission_area_from_target(
--     uuid, text, double precision, double precision, text, text, numeric, text, integer);

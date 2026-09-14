-- 0137_manual_mission_area.sql
--
-- A manager can create an exploration_area by hand — no AI recommendation
-- involved. This fills a real gap: "+ AI Recommended Area" only creates an
-- area when the deterministic engine finds at least one candidate cell with
-- occurrence/association/community/geology-unit evidence, and (until a
-- server-side pack equivalent exists) the server is BLIND to structural
-- (fault/contact), terrain and lithology-prior evidence — see
-- score-mission-cells/accept-recommended-area's own EVIDENCE_CAVEAT. A
-- manager who already knows a location matters (e.g. a mapped fault they
-- can see with their own eyes) had no way to act on that knowledge until
-- this RPC.
--
-- Same MultiPolygon k-ring envelope shape create_mission_area_from_target
-- uses, just with no target_h3/target_score/commodity — this is honestly
-- origin='user', not 'ai_recommended'.

create or replace function enterprise.create_manual_mission_area(
  p_mission uuid,
  p_name text,
  p_center_lat double precision,
  p_center_lng double precision,
  p_boundary_geojson text,
  p_envelope_rings int
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
    name, origin, creator_id, project_id, center, boundary, source_envelope_rings, created_by
  ) values (
    btrim(p_name), 'user', auth.uid(), v_project_id, v_center, v_boundary, p_envelope_rings, auth.uid()
  ) returning id into v_area_id;

  insert into enterprise.mission_area (mission_id, area_id) values (p_mission, v_area_id);

  insert into enterprise.audit_log (actor_id, action, entity_type, entity_id, after, context)
  values (auth.uid(), 'mission_create_area', 'exploration_area', v_area_id,
    jsonb_build_object('mission_id', p_mission, 'name', btrim(p_name), 'origin', 'user', 'envelope_rings', p_envelope_rings),
    jsonb_build_object('source', 'enterprise.create_manual_mission_area'));

  return v_area_id;
end;
$$;
grant execute on function enterprise.create_manual_mission_area(uuid, text, double precision, double precision, text, int) to authenticated;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select has_function_privilege('authenticated', 'enterprise.create_manual_mission_area(uuid,text,double precision,double precision,text,int)', 'execute');

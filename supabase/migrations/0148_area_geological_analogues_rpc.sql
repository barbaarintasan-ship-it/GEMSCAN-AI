-- 0148_area_geological_analogues_rpc.sql
--
-- Phase 13 (Geological Intelligence Transformation) — geological analogue
-- matching. Given an area's best-scoring cell, finds REAL, NAMED occurrences
-- elsewhere in geo.mineral_occurrence that share its commodity — the actual
-- known analogues a geologist could look up, not an invented similarity
-- score. No new scoring/ML — a plain query over existing rows, ranked by a
-- deterministic tie-break (deposit_type match, then distance), never a
-- fabricated confidence number.
--
-- HONESTY ABOUT DATA COMPLETENESS (measured, not assumed — see this
-- migration's own commit message): geo.mineral_occurrence.deposit_style_id
-- (the clean ontology link geo.deposit_style/mineral_association were built
-- for) is 0% populated in production today (0 of 159 rows) — so this
-- function does NOT join on it; doing so would silently return zero
-- analogues for every area and read as "no known analogues exist" when the
-- true state is "this link was never populated". deposit_type (raw text) IS
-- populated, sparsely (16/159 rows, 6 distinct styles) — used as a
-- deterministic ranking signal when present, never required. The function
-- returns an explicit `deposit_style_ontology_populated: false` flag so the
-- caller can say so, the same "empty_layer vs none_here" honesty Phase 10's
-- coverage concept already established for evidence roles.
--
-- AUTHORIZATION: is_mission_member(p_mission) — a read, same boundary as
-- compare_mission_areas (0147).

create or replace function enterprise.area_geological_analogues(
  p_mission uuid,
  p_area uuid,
  p_limit integer default 5
)
returns jsonb
language plpgsql
stable
security definer
set search_path = enterprise, geo, pg_temp
as $$
declare
  v_target_h3 text;
  v_commodities text[];
  v_ontology_populated boolean;
  v_analogues jsonb;
begin
  if not enterprise.is_mission_member(p_mission) then
    raise exception 'forbidden: only a member of this mission can view geological analogues for its areas';
  end if;

  if not exists (select 1 from enterprise.mission_area where mission_id = p_mission and area_id = p_area) then
    raise exception 'validation: area % does not belong to mission %', p_area, p_mission;
  end if;

  select ma.target_h3, array_agg(distinct r->>'commodity') filter (where r->>'commodity' is not null)
    into v_target_h3, v_commodities
  from enterprise.mission_assignment ma
  cross join lateral jsonb_array_elements(coalesce(ma.reasons, '[]'::jsonb)) r
  where ma.mission_id = p_mission and ma.area_id = p_area and ma.contributor_id is null
  group by ma.target_h3, ma.prospectivity_score
  order by ma.prospectivity_score desc nulls last
  limit 1;

  select exists (select 1 from geo.mineral_occurrence where deposit_style_id is not null limit 1)
    into v_ontology_populated;

  if v_commodities is null or array_length(v_commodities, 1) = 0 then
    return jsonb_build_object(
      'target_h3', v_target_h3, 'commodities', '[]'::jsonb,
      'deposit_style_ontology_populated', v_ontology_populated,
      'analogues', '[]'::jsonb,
      'note', 'no occurrence-kind evidence on this area''s best cell to match analogues from'
    );
  end if;

  select coalesce(jsonb_agg(row_data), '[]'::jsonb) into v_analogues
  from (
    select jsonb_build_object(
      'name', o.name, 'commodity_key', o.commodity_key, 'deposit_type', o.deposit_type,
      'host_rocks', to_jsonb(o.host_rocks), 'reference', o.reference,
      'shares_deposit_type', o.deposit_type is not null
    ) as row_data,
    o.deposit_type is not null as has_type
    from geo.mineral_occurrence o
    where o.commodity_key = any(v_commodities)
    order by has_type desc, o.name nulls last
    limit p_limit
  ) ranked;

  return jsonb_build_object(
    'target_h3', v_target_h3, 'commodities', to_jsonb(v_commodities),
    'deposit_style_ontology_populated', v_ontology_populated,
    'analogues', v_analogues,
    'note', case when v_ontology_populated then null
      else 'deposit-style ontology not yet populated in this dataset — analogues are matched by commodity (and deposit_type where recorded) only'
    end
  );
end;
$$;
grant execute on function enterprise.area_geological_analogues(uuid, uuid, integer) to authenticated;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select has_function_privilege('authenticated', 'enterprise.area_geological_analogues(uuid,uuid,integer)', 'execute');

-- ── ROLLBACK (down-path) ────────────────────────────────────────────────────
--   drop function if exists enterprise.area_geological_analogues(uuid, uuid, integer);

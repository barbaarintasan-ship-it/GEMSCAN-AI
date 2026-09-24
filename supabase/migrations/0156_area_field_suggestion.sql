-- 0156_area_field_suggestion.sql
--
-- Issue 3 (2026-09-24 audit) — Phase 17's "Find Gold" buttons called the
-- FORMAL enterprise.review_area RPC (is_mission_manager-gated) for every
-- caller. A field contributor who is not a mission manager got a raw
-- `forbidden` error tapping "Yes, found something" — exactly the audience
-- Phase 17 was built for.
--
-- The fix is NOT to weaken is_mission_manager (Phase 11 stays exactly as
-- decided). It is a separate, deliberately NON-AUTHORITATIVE action: a
-- contributor's field suggestion. Reusing enterprise.sample_structured_
-- evidence (0128) was considered and rejected — it hangs off a `sample_id`
-- and submit_sample() REQUIRES a context photo + a close-up photo before any
-- row can exist, which is the wrong shape for a one-tap "found something /
-- nothing / not sure" suggestion with no sample attached. This is a new,
-- intentionally tiny table instead — not a second evidence system, a
-- different KIND of artifact (an opinion about an area, not a physical
-- specimen).
--
-- A suggestion NEVER writes exploration_area.review_status. Only
-- enterprise.review_area does that, and only a manager can call it — this
-- table exists so a manager has field input to read before deciding, not so
-- contributors can decide for themselves.

do $$ begin
  create type enterprise.field_suggestion as enum ('found_evidence', 'not_found', 'not_sure');
exception when duplicate_object then null;
end $$;

create table if not exists enterprise.area_field_suggestion (
  id             uuid primary key default gen_random_uuid(),
  mission_id     uuid not null references enterprise.exploration_mission(id) on delete cascade,
  area_id        uuid not null references enterprise.exploration_area(id) on delete cascade,
  contributor_id uuid not null references auth.users(id) on delete cascade,
  suggestion     enterprise.field_suggestion not null,
  notes          text,
  created_at     timestamptz not null default now()
);

create index if not exists idx_area_field_suggestion_area on enterprise.area_field_suggestion(area_id);
create index if not exists idx_area_field_suggestion_mission on enterprise.area_field_suggestion(mission_id);
create index if not exists idx_area_field_suggestion_contributor on enterprise.area_field_suggestion(contributor_id);

alter table enterprise.area_field_suggestion enable row level security;

grant select, insert on enterprise.area_field_suggestion to authenticated;
grant select, insert, update, delete on enterprise.area_field_suggestion to service_role;

-- Read: any mission member — the manager needs to see contributor input, and
-- contributors seeing each other's suggestions is the whole point of a team
-- tool (this is not private feedback, it's shared field input).
drop policy if exists area_field_suggestion_select on enterprise.area_field_suggestion;
create policy area_field_suggestion_select on enterprise.area_field_suggestion for select to authenticated
  using (enterprise.is_mission_member(mission_id));

-- Write: any mission member, but ONLY as themselves — contributor_id is
-- checked against auth.uid() in the RLS policy AND re-derived server-side in
-- submit_area_field_suggestion() below (defence in depth, matching
-- review_area's own pattern of never trusting a client-supplied identity).
drop policy if exists area_field_suggestion_insert on enterprise.area_field_suggestion;
create policy area_field_suggestion_insert on enterprise.area_field_suggestion for insert to authenticated
  with check (enterprise.is_mission_member(mission_id) and contributor_id = auth.uid());

comment on table enterprise.area_field_suggestion is
  'A mission contributor''s non-authoritative suggestion about an area (Phase 17 Issue 3). NEVER writes exploration_area.review_status — only enterprise.review_area (Phase 11, manager-gated) does that. Read by a manager as input, not a decision.';

-- ── submit_area_field_suggestion(): the only way to write a row ────────────
create or replace function enterprise.submit_area_field_suggestion(
  p_mission uuid,
  p_area uuid,
  p_suggestion text,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = enterprise, pg_temp
as $$
declare
  v_id uuid;
  v_suggestion enterprise.field_suggestion;
begin
  if not enterprise.is_mission_member(p_mission) then
    raise exception 'forbidden: only a member of this mission can submit a field suggestion';
  end if;

  if not exists (select 1 from enterprise.mission_area where mission_id = p_mission and area_id = p_area) then
    raise exception 'validation: area % does not belong to mission %', p_area, p_mission;
  end if;

  begin
    v_suggestion := p_suggestion::enterprise.field_suggestion;
  exception when invalid_text_representation then
    raise exception 'validation: suggestion must be one of found_evidence, not_found, not_sure';
  end;

  insert into enterprise.area_field_suggestion (mission_id, area_id, contributor_id, suggestion, notes)
  values (p_mission, p_area, auth.uid(), v_suggestion, nullif(btrim(coalesce(p_notes, '')), ''))
  returning id into v_id;

  return jsonb_build_object(
    'id', v_id, 'mission_id', p_mission, 'area_id', p_area,
    'contributor_id', auth.uid(), 'suggestion', v_suggestion, 'created_at', now()
  );
end;
$$;
grant execute on function enterprise.submit_area_field_suggestion(uuid, uuid, text, text) to authenticated;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select count(*) from pg_policies where schemaname='enterprise' and tablename='area_field_suggestion';  -- expect 2
--   select has_function_privilege('authenticated', 'enterprise.submit_area_field_suggestion(uuid,uuid,text,text)', 'execute');

-- ── ROLLBACK (down-path) ────────────────────────────────────────────────────
--   drop function if exists enterprise.submit_area_field_suggestion(uuid, uuid, text, text);
--   drop policy if exists area_field_suggestion_insert on enterprise.area_field_suggestion;
--   drop policy if exists area_field_suggestion_select on enterprise.area_field_suggestion;
--   drop table if exists enterprise.area_field_suggestion;
--   drop type if exists enterprise.field_suggestion;

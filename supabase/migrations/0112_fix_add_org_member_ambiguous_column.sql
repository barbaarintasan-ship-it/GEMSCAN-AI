-- 0112_fix_add_org_member_ambiguous_column.sql
--
-- Fixes enterprise.add_org_member_by_email(): it declared
-- `returns table (user_id uuid, email text, role enterprise.org_role)`,
-- which creates PL/pgSQL OUT-parameter variables named user_id/email/role.
-- Those names collide with enterprise.organization_member's own columns
-- inside the function's INSERT ... ON CONFLICT (organization_id, user_id)
-- statement, and Postgres cannot tell the OUT parameter from the table
-- column — every call failed with:
--   ERROR: column reference "user_id" is ambiguous
-- (confirmed live: every add-teammate attempt from the app returned HTTP 400
-- with this error, never reaching the INSERT).
--
-- Fix: the caller (mobile team.ts) never reads the RPC's return value — it
-- only awaits success/failure — so this drops the RETURNS TABLE entirely
-- rather than renaming around the collision.

-- Return type changed (table -> void), so the old signature must be dropped
-- before recreating it — CREATE OR REPLACE cannot change a return type.
drop function if exists enterprise.add_org_member_by_email(uuid, text);

create function enterprise.add_org_member_by_email(p_org uuid, p_email text)
returns void
language plpgsql
security definer
set search_path = enterprise, auth, pg_temp
as $$
declare
  v_role     enterprise.org_role;
  v_max      integer;
  v_used     bigint;
  v_target   uuid;
  v_email    text := lower(trim(p_email));
begin
  v_role := enterprise.org_role_of(p_org);
  if v_role is null or v_role not in ('owner', 'admin') then
    raise exception 'forbidden: only an owner or admin can add team members';
  end if;

  if v_email = '' or v_email is null then
    raise exception 'validation: email is required';
  end if;

  select max_seats into v_max from enterprise.organization where id = p_org;
  if v_max is not null then
    select count(*) into v_used from enterprise.organization_member where organization_id = p_org;
    if v_used >= v_max then
      raise exception 'seat_limit_reached: this plan is limited to % seat(s)', v_max;
    end if;
  end if;

  select u.id into v_target from auth.users u where lower(u.email) = v_email limit 1;
  if v_target is null then
    raise exception 'no_account: no GEMSCAN account exists for %; ask them to sign up first, then try again', p_email;
  end if;

  insert into enterprise.organization_member (organization_id, user_id, role)
  values (p_org, v_target, 'member')
  on conflict (organization_id, user_id) do nothing;
end;
$$;
grant execute on function enterprise.add_org_member_by_email(uuid, text) to authenticated;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select prorettype::regtype from pg_proc where proname = 'add_org_member_by_email'
--     and pronamespace = 'enterprise'::regnamespace; -- expect: void

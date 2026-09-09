-- 0111_enterprise_seat_management.sql
--
-- Self-serve team management for Enterprise orgs, plus seat-count enforcement
-- for the new per-seat pricing tiers (Solo/Team/Business — 1/2/3 seats).
--
-- Today an owner/admin CAN insert organization_member rows directly (RLS
-- already allows it, migration 0035) but only by user_id — the app has no way
-- to resolve a teammate's email to a user_id (auth.users is not client-
-- readable), and there is no seat cap at all. This migration adds both via
-- SECURITY DEFINER RPCs, following the enterprise.review_sample /
-- enterprise.org_role_of pattern already used in this schema.
--
-- No new tables. Idempotent: CREATE OR REPLACE, ADD COLUMN IF NOT EXISTS.

alter table enterprise.organization
  add column if not exists max_seats integer;

comment on column enterprise.organization.max_seats is
  'Purchased seat cap for this org (1/2/3 for the Solo/Team/Business Enterprise tiers). NULL = no cap (legacy/manual activations before this migration).';

-- ── my_organizations(): what the caller sees in "Manage Team" ──────────────
-- Every org the caller belongs to, their role in it, and current seat usage.
-- In practice each paying customer has exactly one org, but this does not
-- assume that.
create or replace function enterprise.my_organizations()
returns table (
  organization_id uuid,
  name text,
  plan text,
  status text,
  my_role enterprise.org_role,
  max_seats integer,
  seats_used bigint
)
language sql
stable
security definer
set search_path = enterprise, pg_temp
as $$
  select
    o.id,
    o.name,
    o.plan,
    o.status,
    m.role,
    o.max_seats,
    (select count(*) from enterprise.organization_member om where om.organization_id = o.id)
  from enterprise.organization_member m
  join enterprise.organization o on o.id = m.organization_id
  where m.user_id = auth.uid();
$$;
grant execute on function enterprise.my_organizations() to authenticated;

-- ── list_org_members(): roster with email (auth.users is not client-readable) ─
create or replace function enterprise.list_org_members(p_org uuid)
returns table (
  user_id uuid,
  email text,
  role enterprise.org_role,
  joined_at timestamptz
)
language sql
stable
security definer
set search_path = enterprise, pg_temp
as $$
  select m.user_id, u.email, m.role, m.added_at
  from enterprise.organization_member m
  join auth.users u on u.id = m.user_id
  where m.organization_id = p_org
    and enterprise.is_org_member(p_org)   -- caller must belong to this org
  order by m.added_at asc;
$$;
grant execute on function enterprise.list_org_members(uuid) to authenticated;

-- ── add_org_member_by_email(): the self-serve "add a teammate" action ──────
-- Caller must be owner/admin of the org. The invitee must already have a
-- GEMSCAN account (no pending-invite table exists) — if not found, this
-- raises a distinct, client-detectable error so the UI can say "ask them to
-- sign up first" rather than a generic failure. Enforces max_seats.
create or replace function enterprise.add_org_member_by_email(p_org uuid, p_email text)
returns table (user_id uuid, email text, role enterprise.org_role)
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

  return query select v_target, v_email, 'member'::enterprise.org_role;
end;
$$;
grant execute on function enterprise.add_org_member_by_email(uuid, text) to authenticated;

-- ── remove_org_member(): the inverse action ─────────────────────────────────
-- Caller must be owner/admin. The org's owner cannot be removed this way
-- (transfer ownership first) — prevents an admin from locking the owner out.
create or replace function enterprise.remove_org_member(p_org uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = enterprise, pg_temp
as $$
declare
  v_role   enterprise.org_role;
  v_target enterprise.org_role;
begin
  v_role := enterprise.org_role_of(p_org);
  if v_role is null or v_role not in ('owner', 'admin') then
    raise exception 'forbidden: only an owner or admin can remove team members';
  end if;

  select role into v_target from enterprise.organization_member
    where organization_id = p_org and user_id = p_user_id;
  if v_target is null then
    return; -- already gone
  end if;
  if v_target = 'owner' then
    raise exception 'validation: the org owner cannot be removed';
  end if;

  delete from enterprise.organization_member where organization_id = p_org and user_id = p_user_id;
end;
$$;
grant execute on function enterprise.remove_org_member(uuid, uuid) to authenticated;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select column_name from information_schema.columns
--     where table_schema='enterprise' and table_name='organization' and column_name='max_seats';
--   select proname from pg_proc p join pg_namespace n on p.pronamespace = n.oid
--     where n.nspname='enterprise' and proname in
--     ('my_organizations','list_org_members','add_org_member_by_email','remove_org_member');
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
--   drop function if exists enterprise.remove_org_member(uuid, uuid);
--   drop function if exists enterprise.add_org_member_by_email(uuid, text);
--   drop function if exists enterprise.list_org_members(uuid);
--   drop function if exists enterprise.my_organizations();
--   alter table enterprise.organization drop column if exists max_seats;

-- Security hardening pass, found during a full audit of the payment system
-- (database RLS + WordPress plugins + Edge Functions) requested by the site
-- owner to find anything a fraudster could exploit. This migration closes the
-- database-side gaps; see gemscan-payment.php and activate-subscription for
-- the matching application-side fixes.

-- ── 1. profiles.email must always mirror auth.users.email ───────────────────
-- BUG: profiles_update_own (0001) has no `with check`, so any authenticated
-- client could run `update profiles set email = 'victim@example.com'` on
-- their own row. activate-subscription resolves which account to grant a
-- paid subscription/credits to purely by profiles.email — so an attacker
-- could "become" a real payer's account by poisoning their own profile row
-- with the payer's email BEFORE the payer's own legitimate purchase webhook
-- fires, diverting the entitlement to the attacker instead.
--
-- Fix: a BEFORE UPDATE trigger that unconditionally resets NEW.email back to
-- the verified auth.users.email, regardless of what any update (client or
-- otherwise) tries to set it to. This is simpler and more robust than trying
-- to express "email is immutable" as an RLS `with check` (which would need a
-- same-row subquery whose OLD-row visibility semantics are easy to get
-- subtly wrong) — the trigger approach can't be bypassed by any future
-- policy change either.
create or replace function public.enforce_profile_email_immutable()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  select email into new.email from auth.users where id = new.id;
  return new;
end;
$$;

drop trigger if exists enforce_profile_email_immutable on public.profiles;
create trigger enforce_profile_email_immutable
  before update on public.profiles
  for each row execute function public.enforce_profile_email_immutable();

-- Keep profiles.email in sync going forward if a user legitimately changes
-- their auth email through Supabase Auth's own (verified) flow — mirrors the
-- existing handle_new_user trigger's insert-time behavior.
create or replace function public.handle_user_email_change()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.email is distinct from old.email then
    update public.profiles set email = new.email, updated_at = now() where id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_updated on auth.users;
create trigger on_auth_user_email_updated
  after update of email on auth.users
  for each row execute function public.handle_user_email_change();

-- One-time backfill: repair any profiles.email already poisoned by the gap
-- above before this migration runs.
update public.profiles p
   set email = u.email, updated_at = now()
  from auth.users u
 where p.id = u.id
   and p.email is distinct from u.email;

-- ── 2. Idempotent Deep Scan credit grants ────────────────────────────────────
-- BUG: activate-subscription's add_credits action called add_deep_scan_credits
-- (additive, migration 0005) with no reference id and no audit trail — unlike
-- every other payment path in this codebase, a retried or replayed identical
-- grant request added credits again with no way to detect "already applied".
--
-- Fix: a new atomic function that, given an optional idempotency reference
-- (e.g. a Stripe session id), checks payment_events for a prior grant with
-- that exact reference and no-ops (returns the current balance) if found,
-- otherwise grants the credits AND records the payment_events row in the
-- same transaction — closing the check-then-act race a separate SELECT then
-- INSERT would have.
create or replace function public.add_deep_scan_credits_idempotent(
  p_user_id uuid,
  p_credits integer,
  p_reference text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  new_balance integer;
begin
  if p_credits is null or p_credits <= 0 then
    raise exception 'p_credits must be positive';
  end if;

  if p_reference is not null and exists (
    select 1 from public.payment_events
    where source = 'activate-subscription'
      and event_type = 'add_credits'
      and external_reference_id = p_reference
  ) then
    select purchased_balance into new_balance
      from public.deep_scan_credits where user_id = p_user_id;
    return coalesce(new_balance, 0);
  end if;

  insert into public.deep_scan_credits (user_id, purchased_balance, updated_at)
  values (p_user_id, p_credits, now())
  on conflict (user_id)
  do update set purchased_balance = public.deep_scan_credits.purchased_balance + excluded.purchased_balance,
                updated_at = now()
  returning purchased_balance into new_balance;

  if p_reference is not null then
    insert into public.payment_events (source, event_type, external_reference_id, user_id, payload)
    values ('activate-subscription', 'add_credits', p_reference, p_user_id, jsonb_build_object('credits', p_credits));
  end if;

  return new_balance;
end;
$$;

revoke all on function public.add_deep_scan_credits_idempotent(uuid, integer, text) from public, anon, authenticated;

-- ── 3. Lock the $5 report price at the database level, not just the RLS insert
--       policy (defense in depth — a fixed CHECK constraint can't be loosened
--       by a future policy edit the way an RLS `with check` clause could be).
alter table public.high_value_report_purchases
  add constraint high_value_report_purchases_amount_fixed check (amount_usd = 5.00);
alter table public.gold_report_purchases
  add constraint gold_report_purchases_amount_fixed check (amount_usd = 5.00);

-- ── 4. diamond_verifications / gold_verifications: re-validate scan_id
--       ownership on UPDATE, not just INSERT ─────────────────────────────────
-- BUG: the update policies (0009, 0013) only re-checked `user_id`, so a
-- client could repoint their own verification row's scan_id at a DIFFERENT
-- user's scan. Today's fail-closed webhooks and RLS-scoped verdict reads
-- mean this can't yet be turned into fraud or a report unlock, but it's a
-- privacy/data-integrity gap (a victim's fuzzed capture_location and scan
-- result could be forwarded to the verification AI as part of someone else's
-- paid evaluation) that should be closed before any real payment gateway is
-- wired up.
drop policy if exists "diamond_verifications_update_own" on public.diamond_verifications;
create policy "diamond_verifications_update_own"
  on public.diamond_verifications for update
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.scans
      where scans.id = diamond_verifications.scan_id and scans.user_id = auth.uid()
    )
  );

drop policy if exists "gold_verifications_update_own" on public.gold_verifications;
create policy "gold_verifications_update_own"
  on public.gold_verifications for update
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.scans
      where scans.id = gold_verifications.scan_id and scans.user_id = auth.uid()
    )
  );

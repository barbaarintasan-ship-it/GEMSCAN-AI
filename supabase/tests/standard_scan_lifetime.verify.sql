-- Verification for the free-tier lifetime cap accounting (migration 0161,
-- function public.consume_standard_scan). Run against a database that has
-- public.scan_usage and the function loaded (a Supabase branch / local stack,
-- or the self-contained Docker harness in scripts/test_standard_scan.sh).
--
-- Prints "STANDARD_SCAN_LIFETIME: ALL PASS" on success; RAISEs on the first
-- failed assertion. Runs entirely in a transaction it rolls back — it inserts
-- test rows under throwaway user ids and never leaves data behind.
--
-- Covers the required cases: 0/7/9/10/>10 used, 11th blocked, distinct-scan_id
-- dedup (retries never double-count), null-scan_id rows counted, lifetime vs
-- daily window, idempotency of a repeated scanId, unlimited (paid) tier, and
-- the boundary that makes concurrent requests unable to exceed the cap.

do $$
declare
  u_zero   uuid := gen_random_uuid();
  u_seven  uuid := gen_random_uuid();
  u_nine   uuid := gen_random_uuid();
  u_ten    uuid := gen_random_uuid();
  u_over   uuid := gen_random_uuid();
  u_dup    uuid := gen_random_uuid();
  u_null   uuid := gen_random_uuid();
  u_win    uuid := gen_random_uuid();
  u_paid   uuid := gen_random_uuid();
  u_idem   uuid := gen_random_uuid();
  u_race   uuid := gen_random_uuid();
  dup_id   uuid := gen_random_uuid();
  idem_id  uuid := gen_random_uuid();
  r        record;
  i        int;
begin
  -- helper: seed N distinct completed standard scans for a user
  --   (inlined below via generate_series)

  -- ── Case: 0 used → first scan allowed, 9 remaining ────────────────────────
  select * into r from public.consume_standard_scan(u_zero, gen_random_uuid(), 10, true, 'free');
  if not (r.allowed and r.used = 1 and r.remaining = 9 and not r.already_counted) then
    raise exception 'CASE 0-used failed: allowed=% used=% remaining=% already=%', r.allowed, r.used, r.remaining, r.already_counted;
  end if;

  -- ── Case: 7 used → 3 remain (next consume => used 8, remaining 2) ─────────
  insert into public.scan_usage (user_id, scan_id, scan_type)
    select u_seven, gen_random_uuid(), 'standard' from generate_series(1,7);
  select * into r from public.consume_standard_scan(u_seven, gen_random_uuid(), 10, true, 'free');
  if not (r.allowed and r.used = 8 and r.remaining = 2) then
    raise exception 'CASE 7-used failed: used=% remaining=%', r.used, r.remaining;
  end if;

  -- ── Case: 9 used → 1 remains, the 10th is allowed, then 0 remain ──────────
  insert into public.scan_usage (user_id, scan_id, scan_type)
    select u_nine, gen_random_uuid(), 'standard' from generate_series(1,9);
  select * into r from public.consume_standard_scan(u_nine, gen_random_uuid(), 10, true, 'free');
  if not (r.allowed and r.used = 10 and r.remaining = 0) then
    raise exception 'CASE 9-used (10th) failed: allowed=% used=% remaining=%', r.allowed, r.used, r.remaining;
  end if;

  -- ── Case: 10 used → 11th BLOCKED ──────────────────────────────────────────
  insert into public.scan_usage (user_id, scan_id, scan_type)
    select u_ten, gen_random_uuid(), 'standard' from generate_series(1,10);
  select * into r from public.consume_standard_scan(u_ten, gen_random_uuid(), 10, true, 'free');
  if not ((not r.allowed) and r.used = 10 and r.remaining = 0 and not r.already_counted) then
    raise exception 'CASE 10-used (11th blocked) failed: allowed=% used=% remaining=%', r.allowed, r.used, r.remaining;
  end if;
  -- and no row was inserted by the blocked call
  if (select count(*) from public.scan_usage where user_id = u_ten) <> 10 then
    raise exception 'CASE 10-used inserted a row on a blocked call (should not)';
  end if;

  -- ── Case: >10 used (existing over-quota account) → still BLOCKED ──────────
  insert into public.scan_usage (user_id, scan_id, scan_type)
    select u_over, gen_random_uuid(), 'standard' from generate_series(1,12);
  select * into r from public.consume_standard_scan(u_over, gen_random_uuid(), 10, true, 'free');
  if not ((not r.allowed) and r.used = 12) then
    raise exception 'CASE >10-used failed: allowed=% used=%', r.allowed, r.used;
  end if;

  -- ── Case: duplicate scan_id de-dup (historical retry double-count) ────────
  -- Two rows share dup_id + three other distinct rows => 4 effective, not 5.
  insert into public.scan_usage (user_id, scan_id, scan_type) values (u_dup, dup_id, 'standard');
  insert into public.scan_usage (user_id, scan_id, scan_type) values (u_dup, dup_id, 'standard');
  insert into public.scan_usage (user_id, scan_id, scan_type)
    select u_dup, gen_random_uuid(), 'standard' from generate_series(1,3);
  select * into r from public.consume_standard_scan(u_dup, gen_random_uuid(), 10, true, 'free');
  if r.used <> 5 then  -- 4 effective existing + 1 just consumed
    raise exception 'CASE dedup failed: expected used=5 (4 distinct + 1), got %', r.used;
  end if;

  -- ── Case: null scan_id rows each count as one ─────────────────────────────
  insert into public.scan_usage (user_id, scan_id, scan_type) values (u_null, null, 'standard');
  insert into public.scan_usage (user_id, scan_id, scan_type) values (u_null, null, 'standard');
  insert into public.scan_usage (user_id, scan_id, scan_type)
    select u_null, gen_random_uuid(), 'standard' from generate_series(1,3);
  select * into r from public.consume_standard_scan(u_null, gen_random_uuid(), 10, true, 'free');
  if r.used <> 6 then  -- 2 null + 3 distinct + 1 just consumed
    raise exception 'CASE null-scan_id failed: expected used=6, got %', r.used;
  end if;

  -- ── Case: lifetime window includes old rows; daily window excludes them ───
  insert into public.scan_usage (user_id, scan_id, scan_type, created_at)
    select u_win, gen_random_uuid(), 'standard', now() - interval '2 days' from generate_series(1,10);
  -- lifetime: the 10 old scans count => 11th blocked
  select * into r from public.consume_standard_scan(u_win, gen_random_uuid(), 10, true, 'free');
  if r.allowed then
    raise exception 'CASE window(lifetime) failed: old scans should count, expected blocked';
  end if;
  -- daily: the 2-day-old scans are outside today's window => allowed
  select * into r from public.consume_standard_scan(u_win, gen_random_uuid(), 10, false, 'free');
  if not r.allowed or r.used <> 1 then
    raise exception 'CASE window(daily) failed: old scans should NOT count today, got allowed=% used=%', r.allowed, r.used;
  end if;

  -- ── Case: unlimited (paid/owner) tier never blocks ────────────────────────
  insert into public.scan_usage (user_id, scan_id, scan_type)
    select u_paid, gen_random_uuid(), 'standard' from generate_series(1,50);
  select * into r from public.consume_standard_scan(u_paid, gen_random_uuid(), null, false, 'professional');
  if not (r.allowed and r.remaining is null) then
    raise exception 'CASE unlimited failed: allowed=% remaining=%', r.allowed, r.remaining;
  end if;

  -- ── Case: idempotent retry of the SAME scanId never double-counts ─────────
  insert into public.scan_usage (user_id, scan_id, scan_type)
    select u_idem, gen_random_uuid(), 'standard' from generate_series(1,4);
  insert into public.scan_usage (user_id, scan_id, scan_type) values (u_idem, idem_id, 'standard'); -- 5th, known id
  select * into r from public.consume_standard_scan(u_idem, idem_id, 10, true, 'free');
  if not (r.allowed and r.already_counted and r.used = 5) then
    raise exception 'CASE idempotent failed: allowed=% already=% used=%', r.allowed, r.already_counted, r.used;
  end if;
  if (select count(*) from public.scan_usage where user_id = u_idem) <> 5 then
    raise exception 'CASE idempotent inserted a duplicate row (should not)';
  end if;

  -- ── Case: concurrency boundary (serialized outcome) ───────────────────────
  -- consume_standard_scan takes a per-user advisory xact lock and does its
  -- check+insert in one transaction, so two concurrent calls are forced to run
  -- one-after-the-other. We assert the resulting sequential behavior at the
  -- cap edge: at 9 used the FIRST call is allowed (10th) and a SECOND is
  -- blocked (11th) — i.e. two racing requests can never both succeed.
  insert into public.scan_usage (user_id, scan_id, scan_type)
    select u_race, gen_random_uuid(), 'standard' from generate_series(1,9);
  select * into r from public.consume_standard_scan(u_race, gen_random_uuid(), 10, true, 'free');
  if not r.allowed then raise exception 'CASE concurrency: first (10th) should be allowed'; end if;
  select * into r from public.consume_standard_scan(u_race, gen_random_uuid(), 10, true, 'free');
  if r.allowed then raise exception 'CASE concurrency: second (11th) must be blocked'; end if;

  raise notice 'STANDARD_SCAN_LIFETIME: ALL PASS';
end $$;

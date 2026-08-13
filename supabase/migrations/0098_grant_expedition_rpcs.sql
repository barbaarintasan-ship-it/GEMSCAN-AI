-- 0098_grant_expedition_rpcs.sql
--
-- The expedition sync could never have worked. Nothing was granted EXECUTE.
--
-- WHY
-- ---
-- 0095 created four SECURITY DEFINER RPCs and correctly revoked them from
-- PUBLIC — and then never granted them to anybody. The edge function reaches
-- them with the service key, so PostgREST authenticates as `service_role`, and
-- `service_role` had no EXECUTE. Every drain therefore reached the server,
-- authenticated, passed requireEnterprise, and died inside Postgres:
--
--   permission denied for function upsert_field_observation
--   permission denied for function upsert_expedition_track
--
-- Found in the field, on the device's own Diagnostics panel, with 23 records
-- queued and "Successfully synced: 0 filed with the server". Not one expedition,
-- observation or traverse has ever reached the database since Slice 2 shipped —
-- including a 130 km survey through the Karkaar mountains on 2026-08-07, which is
-- still sitting in the outbox on the phone.
--
-- 0093 got this right for the analysis RPCs — revoke from public, THEN grant to
-- service_role — and 0095 copied only the first half. That asymmetry is the whole
-- bug.
--
-- NOTHING IS LOST. The outbox is durable and retries with backoff, so the queued
-- records upload themselves once these grants exist. No data needs recovering;
-- it needs permitting.
--
-- Depends on: 0095 (the functions themselves).

grant execute on function enterprise.open_expedition(uuid, text, timestamptz, uuid)
  to service_role;

grant execute on function enterprise.close_expedition(
  uuid, text, timestamptz, double precision, bigint, integer, text
) to service_role;

grant execute on function enterprise.upsert_field_observation(uuid, text, jsonb)
  to service_role;

grant execute on function enterprise.upsert_expedition_track(
  uuid, text, jsonb, double precision, bigint
) to service_role;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
-- Expect 4 rows, each with has_execute = true.
--
--   select p.proname,
--          has_function_privilege('service_role', p.oid, 'EXECUTE') as has_execute
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'enterprise'
--      and p.proname in ('open_expedition','close_expedition',
--                        'upsert_field_observation','upsert_expedition_track')
--    order by p.proname;
--
-- Then, after the device drains (it retries on its own, or reopen the app):
--
--   select e.device_session_id, e.started_at,
--          round((e.distance_m/1000)::numeric, 1) as km,
--          e.observation_count, t.point_count
--     from enterprise.expedition e
--     left join enterprise.expedition_track t on t.expedition_id = e.id
--    order by e.started_at desc;

-- ── ROLLBACK (down-path) ────────────────────────────────────────────────────
--   revoke execute on function enterprise.open_expedition(uuid, text, timestamptz, uuid) from service_role;
--   revoke execute on function enterprise.close_expedition(uuid, text, timestamptz, double precision, bigint, integer, text) from service_role;
--   revoke execute on function enterprise.upsert_field_observation(uuid, text, jsonb) from service_role;
--   revoke execute on function enterprise.upsert_expedition_track(uuid, text, jsonb, double precision, bigint) from service_role;

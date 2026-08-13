-- 0096_sample_client_local_id.sql
--
-- Offline-first sample submission: the device's own id, so a retry can never
-- create a second sample.
--
-- WHY
-- ---
-- A field submission carries megabytes of photographs over a cellular link that
-- routinely dies mid-request. When it does, the device cannot know whether the
-- server got the record: the safe assumption is "maybe", and the safe behaviour
-- is to try again. Without an idempotency key that is how a geologist ends up
-- with the same outcrop in the collection four times — each with its own AI
-- analysis, each costing an inference.
--
-- The key is the id the DEVICE minted when the sample was taken
-- (lib/samples/localSampleStore). It exists before the network is involved, it
-- survives a restart, and it is unique per collector.
--
-- Additive and backward compatible: the column is nullable, so every existing
-- row and every caller that does not send one behaves exactly as before. The
-- unique index is PARTIAL for the same reason — thousands of historical NULLs
-- must not collide with each other.
--
-- Depends on: 0023 (enterprise.sample).

alter table enterprise.sample
  add column if not exists client_local_id text;

-- Unique per collector, not globally: two devices may independently mint the
-- same short id, and neither submission should be able to overwrite the other's.
create unique index if not exists uq_sample_client_local
  on enterprise.sample (created_by, client_local_id)
  where client_local_id is not null;

comment on column enterprise.sample.client_local_id is
  'Device-minted id for the submission. Idempotency key: a retry after an '
  'unknown outcome finds the existing row instead of inserting a second one.';

-- ── Lookup used by the API before it inserts ───────────────────────────────
-- SECURITY DEFINER with the actor passed explicitly, exactly like the other
-- sample RPCs (0059/0063/0080/0094), so the edge function can resolve a retry
-- without the client being able to ask about anyone else's samples.
create or replace function enterprise.find_sample_by_client_id(
  p_actor uuid, p_client_local_id text
) returns uuid
language sql
stable
security definer
set search_path = enterprise, public
as $$
  select id
    from enterprise.sample
   where created_by = p_actor
     and client_local_id = p_client_local_id
     and deleted_at is null
   limit 1;
$$;

revoke all on function enterprise.find_sample_by_client_id(uuid, text) from public;

-- ── Stamp the id onto a freshly created sample ─────────────────────────────
-- Kept separate from submit_sample rather than changing it: submit_sample is a
-- validated, audited write path used by the existing app, and adding a parameter
-- to it would mean re-testing every caller for one nullable column. This runs
-- immediately after, in the same request.
--
-- On a unique violation another request won the race with the same id. That is
-- not an error — it is exactly the case this feature exists for — so the winner's
-- id is returned and the duplicate is removed.
create or replace function enterprise.claim_sample_client_id(
  p_actor uuid, p_sample uuid, p_client_local_id text
) returns uuid
language plpgsql
security definer
set search_path = enterprise, public
as $$
declare v_existing uuid;
begin
  update enterprise.sample
     set client_local_id = p_client_local_id
   where id = p_sample and created_by = p_actor and client_local_id is null;
  return p_sample;
exception when unique_violation then
  select id into v_existing
    from enterprise.sample
   where created_by = p_actor and client_local_id = p_client_local_id and deleted_at is null
   limit 1;
  -- The row just created is the duplicate; drop it so the collection holds one.
  update enterprise.sample set deleted_at = now()
   where id = p_sample and created_by = p_actor;
  return coalesce(v_existing, p_sample);
end;
$$;

revoke all on function enterprise.claim_sample_client_id(uuid, uuid, text) from public;

-- ── VERIFY (CI/CD) — expect column=1, index=1, functions=2 ────────────────
--   select
--     (select count(*) from information_schema.columns where table_schema='enterprise'
--        and table_name='sample' and column_name='client_local_id') as col,
--     (select count(*) from pg_indexes where schemaname='enterprise'
--        and indexname='uq_sample_client_local') as idx,
--     (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--        where n.nspname='enterprise' and p.proname in
--        ('find_sample_by_client_id','claim_sample_client_id')) as functions;

-- ── ROLLBACK (down-path) ──────────────────────────────────────────────────
--   drop function if exists enterprise.claim_sample_client_id(uuid, uuid, text);
--   drop function if exists enterprise.find_sample_by_client_id(uuid, text);
--   drop index if exists enterprise.uq_sample_client_local;
--   alter table enterprise.sample drop column if exists client_local_id;

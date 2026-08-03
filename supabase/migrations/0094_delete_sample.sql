-- Let a collector remove their own samples.
--
-- enterprise.sample has carried a deleted_at column since 0023 and every read
-- path already filters on it, but nothing could ever set it. A field collector
-- accumulates mistaken submissions, duplicates and test entries, and had no way
-- to clear them.
--
-- SOFT delete. The row stays so that audit history, any assessment already
-- written, and any review that referenced it remain coherent; the reads all
-- filter it out, so it is gone from the collector's point of view. A hard
-- delete would silently rewrite the record a geologist may have acted on.

create or replace function enterprise.delete_sample(p_actor uuid, p_sample uuid)
returns jsonb
language plpgsql
security definer
set search_path = enterprise, public
as $$
declare
  v_owner  uuid;
  v_status enterprise.sample_status;
  v_paths  text[];
begin
  select collector_id, status into v_owner, v_status
    from enterprise.sample
   where id = p_sample and deleted_at is null;

  -- Already gone, or never existed. Same answer either way: the caller must not
  -- learn whether a sample they cannot see exists.
  if v_owner is null then
    raise exception 'not_found: sample not found';
  end if;

  -- Only the collector. A geologist reviewing a sample must not be able to
  -- delete the evidence they were asked to judge.
  if v_owner <> p_actor then
    raise exception 'forbidden: only the collector can delete their own sample';
  end if;

  -- A verified sample is a geological record that someone signed their name to,
  -- and other work may cite it. Everything else — submitted, processing,
  -- failed, awaiting review, rejected — is the collector's to clear.
  if v_status = 'verified' then
    raise exception 'locked: a verified sample cannot be deleted';
  end if;

  -- Returned so the caller can remove the stored photos. Collected BEFORE the
  -- update, because the read paths stop returning them immediately after.
  select coalesce(array_agg(storage_path), '{}')
    into v_paths
    from enterprise.sample_media
   where sample_id = p_sample;

  update enterprise.sample
     set deleted_at = now(), updated_at = now()
   where id = p_sample;

  insert into enterprise.audit_log (actor_id, action, entity_type, entity_id, after, context)
  values (p_actor, 'update', 'sample', p_sample,
    jsonb_build_object('deleted_at', now(), 'previous_status', v_status::text),
    jsonb_build_object('source', 'delete_sample'));

  return jsonb_build_object('sample_id', p_sample, 'media_paths', to_jsonb(v_paths));
end;
$$;

revoke all on function enterprise.delete_sample(uuid, uuid) from public;
grant execute on function enterprise.delete_sample(uuid, uuid) to service_role;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname='enterprise' and proname='delete_sample';        -- 1 row
--   select count(*) from enterprise.sample where deleted_at is not null;

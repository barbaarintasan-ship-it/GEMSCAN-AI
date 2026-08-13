-- 0100_photo_key_content_type.sql
--
-- The object key stops assuming every photograph is a JPEG.
--
-- THE DEFECT
-- ----------
-- Three places computed the key for one photograph, and they did not agree:
--
--   r2-presign          `missions/{m}/photos/{p}.` + extensionFor(contentType)
--   upsert_mission_package                         + '.jpg'   ← hardcoded
--   photosInPackage (verification)                 + '.jpg'   ← hardcoded
--
-- The presign path already accepted image/png, image/webp and image/heic. So a
-- single non-JPEG photograph would have been signed to `…/p.png`, uploaded
-- successfully to `…/p.png`, recorded in the database as `…/p.jpg`, and then
-- looked for at `…/p.jpg` by the verification pass.
--
-- The failure that produces is the worst shape available: the gate reports a key
-- it cannot HEAD as "photograph not in storage", which is a WAITING state, not an
-- error. The mission would have sat at `section_completed` for ever, waiting for a
-- file that had been in the bucket the whole time, with nothing anywhere saying
-- why. No exception, no log, no failed row.
--
-- WHY IT NEVER FIRED
-- ------------------
-- The field camera writes `{photoId}.jpg` and the upload queue defaults the type
-- to image/jpeg, so every photograph taken so far genuinely is a JPEG and every
-- stored `.jpg` key is correct. This is a latent defect being closed before it can
-- fire — not an incident. No backfill is required and none is performed: existing
-- `evidence_photo` rows are accurate.
--
-- THE FIX
-- -------
-- The extension is derived from the content type in all three places, from one
-- rule. `geo.photo_extension` mirrors `extensionFor` in
-- supabase/functions/_shared/r2/sign.ts one-for-one; the TypeScript side is now
-- imported from that one module rather than redefined, and a test pins the two
-- implementations to the same table of inputs.
--
-- The key is still RECOMPUTED here rather than read from the package. A device
-- that sent a key of its own choosing could otherwise point a row at another
-- mission's object, and that property is worth more than the duplication costs.
--
-- Additive and idempotent. Depends on: 0099 (geo.field_mission, evidence_photo,
-- mission_package, upsert_mission_package).

-- ── The extension rule, named once ──────────────────────────────────────────
-- IMMUTABLE so it may be used in an index or a generated column later without a
-- rewrite. Mirrors extensionFor(): jpeg/jpg → 'jpg'; any other well-formed
-- `image/<subtype>` → that subtype; anything unrecognised or absent → 'jpg',
-- because absent means "written before this field existed", and those are JPEG.
create or replace function geo.photo_extension(p_content_type text)
returns text
language sql
immutable
as $$
  select case
    when lower(coalesce(p_content_type, 'image/jpeg')) in ('image/jpeg', 'image/jpg')
      then 'jpg'
    when lower(coalesce(p_content_type, '')) ~ '^image/[a-z0-9]+$'
      then split_part(lower(p_content_type), '/', 2)
    else 'jpg'
  end;
$$;

comment on function geo.photo_extension(text) is
  'Mirrors extensionFor() in _shared/r2/sign.ts. Changing one without the other '
  'puts database rows and object storage back out of step.';

-- ── The key shape, named once ───────────────────────────────────────────────
create or replace function geo.photo_key(
  p_mission text, p_photo text, p_content_type text
) returns text
language sql
immutable
as $$
  select 'missions/' || p_mission || '/photos/' || p_photo || '.'
         || geo.photo_extension(p_content_type);
$$;

-- ── Intake, with the key derived rather than assumed ────────────────────────
-- Unchanged from 0099 except for the photo loop: the key now comes from
-- geo.photo_key, and content_type is stored as sent instead of always taking the
-- column default. Everything else — the validation, the mission upsert, the
-- package upsert, the idempotency — is byte-for-byte the same.
create or replace function geo.upsert_mission_package(
  p_actor uuid,
  p_package jsonb
) returns text
language plpgsql
security definer
set search_path = geo, public
as $$
declare
  v_mission_id text := p_package->>'missionId';
  v_package_id text := p_package->>'id';
  v_photo jsonb;
  v_obs jsonb;
  v_photos integer := 0;
  v_type text;
begin
  -- Named up front. Without this a package missing targetCell fails later on a
  -- not-null constraint, and the device sees an opaque Postgres error instead of
  -- being told which field it did not send.
  if v_mission_id is null or v_package_id is null then
    raise exception 'package must carry missionId and id';
  end if;
  if p_package->>'targetCell' is null then
    raise exception 'package % has no targetCell', v_package_id;
  end if;
  if p_package->'targetCentre'->>'lat' is null
     or p_package->'targetCentre'->>'lng' is null then
    raise exception 'package % has no targetCentre', v_package_id;
  end if;

  insert into geo.field_mission (
    id, user_id, session_id, target_cell, target_lat, target_lng,
    hotspot_lat, hotspot_lng, hotspot_lift, commodity, prospectivity,
    state, started_at, arrived_at, completed_at, updated_at
  ) values (
    v_mission_id,
    p_actor,
    p_package->>'explorationSessionId',
    p_package->>'targetCell',
    (p_package->'targetCentre'->>'lat')::double precision,
    (p_package->'targetCentre'->>'lng')::double precision,
    (p_package->'hotspot'->>'lat')::double precision,
    (p_package->'hotspot'->>'lng')::double precision,
    (p_package->'hotspot'->>'liftOverCentre')::double precision,
    p_package->>'commodity',
    (p_package->>'prospectivityScore')::double precision,
    'section_completed',
    to_timestamp((p_package->>'createdAt')::bigint / 1000.0),
    case when p_package->>'arrivedAt' is null then null
         else to_timestamp((p_package->>'arrivedAt')::bigint / 1000.0) end,
    to_timestamp((p_package->>'completedAt')::bigint / 1000.0),
    now()
  )
  on conflict (id) do update set
    state = 'section_completed',
    commodity = excluded.commodity,
    updated_at = now();

  -- Photo rows come from the package, one per photograph named in it. The bytes
  -- are uploaded separately and directly to R2; `uploaded_at` is set by the
  -- verification pass, never here.
  for v_obs in select * from jsonb_array_elements(coalesce(p_package->'observations', '[]'::jsonb))
  loop
    for v_photo in select * from jsonb_array_elements(coalesce(v_obs->'photos', '[]'::jsonb))
    loop
      -- Missing means a package built before the device sent a type. Those are
      -- JPEG, and photo_extension resolves them to 'jpg' — so the keys of
      -- everything already stored are unchanged by this migration.
      v_type := coalesce(nullif(v_photo->>'contentType', ''), 'image/jpeg');

      insert into geo.evidence_photo (
        id, mission_id, user_id, r2_key, content_type, lat, lng,
        gps_accuracy_m, heading_deg, position_quality, captured_at
      ) values (
        v_photo->>'id',
        v_mission_id,
        p_actor,
        geo.photo_key(v_mission_id, v_photo->>'id', v_type),
        v_type,
        (v_obs->'position'->>'lat')::double precision,
        (v_obs->'position'->>'lng')::double precision,
        (v_obs->'position'->>'accuracyM')::double precision,
        (v_obs->>'headingDeg')::double precision,
        v_obs->>'positionQuality',
        to_timestamp((v_photo->>'capturedAt')::bigint / 1000.0)
      )
      on conflict (id) do nothing;
      v_photos := v_photos + 1;
    end loop;
  end loop;

  insert into geo.mission_package (
    id, mission_id, user_id, version, payload,
    observation_count, photo_count, track_points
  ) values (
    v_package_id, v_mission_id, p_actor,
    coalesce((p_package->>'version')::integer, 1),
    p_package,
    jsonb_array_length(coalesce(p_package->'observations', '[]'::jsonb)),
    v_photos,
    jsonb_array_length(coalesce(p_package->'track', '[]'::jsonb))
  )
  on conflict (id) do update set
    payload = excluded.payload,
    observation_count = excluded.observation_count,
    photo_count = excluded.photo_count,
    track_points = excluded.track_points,
    received_at = now();

  return v_package_id;
end;
$$;

revoke all on function geo.upsert_mission_package(uuid, jsonb) from public;
grant execute on function geo.upsert_mission_package(uuid, jsonb) to service_role;

revoke all on function geo.photo_extension(text) from public;
revoke all on function geo.photo_key(text, text, text) from public;
grant execute on function geo.photo_extension(text) to service_role;
grant execute on function geo.photo_key(text, text, text) to service_role;

-- ── VERIFY (CI/CD) — every row must be true ────────────────────────────────
--   select
--     geo.photo_key('m','p', null)          = 'missions/m/photos/p.jpg'  as absent_is_jpg,
--     geo.photo_key('m','p','image/jpeg')   = 'missions/m/photos/p.jpg'  as jpeg,
--     geo.photo_key('m','p','image/jpg')    = 'missions/m/photos/p.jpg'  as jpg,
--     geo.photo_key('m','p','IMAGE/PNG')    = 'missions/m/photos/p.png'  as png_uppercase,
--     geo.photo_key('m','p','image/webp')   = 'missions/m/photos/p.webp' as webp,
--     geo.photo_key('m','p','image/heic')   = 'missions/m/photos/p.heic' as heic,
--     geo.photo_key('m','p','nonsense')     = 'missions/m/photos/p.jpg'  as junk_is_jpg;

-- ── ROLLBACK (down-path) ───────────────────────────────────────────────────
-- Restores the 0099 body of upsert_mission_package. Safe at any time: it only
-- returns the key to a hardcoded '.jpg', which is correct for every row that
-- exists today.
--   \i supabase/migrations/0099_mission_evidence.sql   -- re-runs the OR REPLACE
--   drop function if exists geo.photo_key(text, text, text);
--   drop function if exists geo.photo_extension(text);

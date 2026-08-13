-- 0104_save_photo_descriptions.sql
--
-- Writing what the model read from each photograph.
--
-- 0103 added `evidence_photo.ai_description` and nothing has ever written to it.
-- The Visual Evidence section of the field report therefore had a column to draw
-- from and nothing in it.
--
-- TWO COLUMNS, AND THEY MUST NOT MERGE
-- ------------------------------------
--   caption         the GEOLOGIST's words, written standing there
--   ai_description  a MODEL's reading of the image
--
-- This function writes the second and never touches the first. A report that lets
-- a model's reading overwrite a geologist's note has quietly promoted a guess to
-- an observation, and nobody downstream could tell afterwards which they were
-- looking at.
--
-- Idempotent; re-running an analysis replaces the description and leaves the
-- caption, the key, the coordinates and the verification stamp exactly as they
-- were. Depends on: 0103 (ai_description).

create or replace function geo.save_photo_descriptions(
  p_actor uuid,
  p_mission text,
  p_described jsonb
) returns integer
language plpgsql
security definer
set search_path = geo, public
as $$
declare
  v_row jsonb;
  v_count integer := 0;
begin
  for v_row in select * from jsonb_array_elements(coalesce(p_described, '[]'::jsonb))
  loop
    update geo.evidence_photo
       set ai_description = nullif(v_row->>'description', '')
     where id = v_row->>'id'
       and mission_id = p_mission
       -- The actor is in the WHERE, not checked beforehand. Photo ids come from a
       -- device and mission ids are guessable, so ownership belongs in the write
       -- itself rather than in a test that a later edit could skip.
       and user_id = p_actor;
    if found then v_count := v_count + 1; end if;
  end loop;
  return v_count;
end;
$$;

revoke all on function geo.save_photo_descriptions(uuid, text, jsonb) from public;
grant execute on function geo.save_photo_descriptions(uuid, text, jsonb) to service_role;

-- ── VERIFY (CI/CD) ─────────────────────────────────────────────────────────
--   select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'geo' and p.proname = 'save_photo_descriptions';   -- expect 1

-- ── ROLLBACK (down-path) ───────────────────────────────────────────────────
--   drop function if exists geo.save_photo_descriptions(uuid, text, jsonb);
--   -- ai_description is left in place: it holds real readings by then, and the
--   -- column is nullable, so nothing depends on it being absent.

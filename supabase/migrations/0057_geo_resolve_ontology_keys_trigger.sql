-- 0057_geo_resolve_ontology_keys_trigger.sql
--
-- Luul Scan — GeoContext P0 addendum: auto-resolve ontology *_key → *_id.
--
-- Resolves Technical Debt #1 (P0 completion report §6.1). A BEFORE INSERT OR UPDATE
-- trigger on geo.geological_knowledge that, for each ontology dimension, fills the
-- *_id FK from the matching ontology.code whenever a match exists — so records
-- created AFTER P1 never rely on *_key alone, and *_id never drifts from a changed
-- *_key. The original *_key values are ALWAYS preserved (never modified) for lineage
-- and auditability.
--
-- Resolution rule per dimension (lightweight, no clobbering of explicit ids):
--   * INSERT — fill *_id from *_key only when *_id is NULL (an explicitly supplied
--     *_id is respected).
--   * UPDATE — re-resolve *_id when *_key CHANGED (prevents drift), or when *_id is
--     still NULL. If *_key has no matching ontology row, *_id becomes NULL (never a
--     stale value); *_key is retained regardless.
--
-- SECURITY DEFINER + pinned search_path (reads ontology tables). geo schema, additive;
-- frozen core/public untouched. Idempotent.

create or replace function geo.resolve_ontology_keys()
returns trigger
language plpgsql
security definer
set search_path = geo, pg_temp
as $$
begin
  if TG_OP = 'INSERT' then
    if new.commodity_key is not null and new.commodity_id is null then
      new.commodity_id := (select id from geo.commodity where code = new.commodity_key);
    end if;
    if new.deposit_style_key is not null and new.deposit_style_id is null then
      new.deposit_style_id := (select id from geo.deposit_style where code = new.deposit_style_key);
    end if;
    if new.host_rock_key is not null and new.host_rock_id is null then
      new.host_rock_id := (select id from geo.host_rock where code = new.host_rock_key);
    end if;
    if new.lithology_key is not null and new.lithology_id is null then
      new.lithology_id := (select id from geo.lithology where code = new.lithology_key);
    end if;
    if new.formation_key is not null and new.formation_id is null then
      new.formation_id := (select id from geo.formation where code = new.formation_key);
    end if;
    if new.tectonic_setting_key is not null and new.tectonic_setting_id is null then
      new.tectonic_setting_id := (select id from geo.tectonic_setting where code = new.tectonic_setting_key);
    end if;

  elsif TG_OP = 'UPDATE' then
    if new.commodity_key is distinct from old.commodity_key or new.commodity_id is null then
      new.commodity_id := (select id from geo.commodity where code = new.commodity_key);
    end if;
    if new.deposit_style_key is distinct from old.deposit_style_key or new.deposit_style_id is null then
      new.deposit_style_id := (select id from geo.deposit_style where code = new.deposit_style_key);
    end if;
    if new.host_rock_key is distinct from old.host_rock_key or new.host_rock_id is null then
      new.host_rock_id := (select id from geo.host_rock where code = new.host_rock_key);
    end if;
    if new.lithology_key is distinct from old.lithology_key or new.lithology_id is null then
      new.lithology_id := (select id from geo.lithology where code = new.lithology_key);
    end if;
    if new.formation_key is distinct from old.formation_key or new.formation_id is null then
      new.formation_id := (select id from geo.formation where code = new.formation_key);
    end if;
    if new.tectonic_setting_key is distinct from old.tectonic_setting_key or new.tectonic_setting_id is null then
      new.tectonic_setting_id := (select id from geo.tectonic_setting where code = new.tectonic_setting_key);
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_resolve_ontology_keys on geo.geological_knowledge;
create trigger trg_resolve_ontology_keys
  before insert or update on geo.geological_knowledge
  for each row execute function geo.resolve_ontology_keys();

-- ── VERIFY (CI/CD) — expect: fn=1, trigger=1 ───────────────────────────────
--   select
--     (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='geo' and p.proname='resolve_ontology_keys') as fn,
--     (select count(*) from pg_trigger where tgname='trg_resolve_ontology_keys' and not tgisinternal) as trg;

-- ── ROLLBACK (down-path) ───────────────────────────────────────────────────
--   drop trigger if exists trg_resolve_ontology_keys on geo.geological_knowledge;
--   drop function if exists geo.resolve_ontology_keys();

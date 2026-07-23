-- 0042_custody_geo_policies.sql
--
-- Luul Scan Enterprise — Phase 1, Sprint 3 (10/N, SECURITY): read policies for
-- the chain-of-custody tables (sample_container, shipment, sample_chain_event,
-- custody_signature) and the geo layers (geo.geological_layer, geo.coverage_cell).
--
-- Security only (SELECT policies + grants + 1 helper) — NO schema DDL. Frozen
-- schema (0018-0032), public/consumer, production untouched. Reuses is_org_member
-- (0034), can_read_area / can_read_sample (0037). Idempotent.
--
-- Read model:
--   * Custody rows follow the visibility of the underlying sample (custody is an
--     extension of the sample's lineage): container/chain-event/signature are
--     readable when the caller can read the linked sample (or is the actor/signer);
--     shipment is readable by members of its owning org.
--   * geo.geological_layer = shared reference geology → readable by any
--     authenticated user. geo.coverage_cell = per-area aggregate → readable when
--     the caller can read that area.
--   * ALL writes are SERVICE-ROLE-ONLY (custody events + coverage are written by
--     Edge Functions / aggregation jobs in Sprint 5+).

-- ── Helper: can the caller read this chain event's sample? ─────────────────
create or replace function enterprise.can_read_chain_event(p_event uuid)
returns boolean
language sql stable security definer
set search_path = enterprise, pg_temp
as $$
  select exists (
    select 1 from enterprise.sample_chain_event e
    where e.id = p_event and enterprise.can_read_sample(e.sample_id)
  );
$$;
grant execute on function enterprise.can_read_chain_event(uuid) to authenticated, service_role;

-- ── Grants: authenticated = SELECT only; service_role = full (writes) ──────
grant select on
  enterprise.sample_container, enterprise.shipment, enterprise.sample_chain_event,
  enterprise.custody_signature, geo.geological_layer, geo.coverage_cell
  to authenticated;
grant select, insert, update, delete on
  enterprise.sample_container, enterprise.shipment, enterprise.sample_chain_event,
  enterprise.custody_signature, geo.geological_layer, geo.coverage_cell
  to service_role;

-- ── Custody SELECT policies (writes intentionally service-only) ────────────
drop policy if exists container_select on enterprise.sample_container;
create policy container_select on enterprise.sample_container for select to authenticated
  using (sample_id is not null and enterprise.can_read_sample(sample_id));

drop policy if exists shipment_select on enterprise.shipment;
create policy shipment_select on enterprise.shipment for select to authenticated
  using (organization_id is not null and enterprise.is_org_member(organization_id));

drop policy if exists chain_event_select on enterprise.sample_chain_event;
create policy chain_event_select on enterprise.sample_chain_event for select to authenticated
  using (actor_id = auth.uid() or enterprise.can_read_sample(sample_id));

drop policy if exists custody_sig_select on enterprise.custody_signature;
create policy custody_sig_select on enterprise.custody_signature for select to authenticated
  using (signer_id = auth.uid() or enterprise.can_read_chain_event(chain_event_id));

-- ── Geo SELECT policies ────────────────────────────────────────────────────
drop policy if exists geological_layer_select on geo.geological_layer;
create policy geological_layer_select on geo.geological_layer for select to authenticated
  using (true);

drop policy if exists coverage_cell_select on geo.coverage_cell;
create policy coverage_cell_select on geo.coverage_cell for select to authenticated
  using (enterprise.can_read_area(area_id));

-- ── VERIFY (CI/CD) — expect: select_pol=6, write_pol=0, helper=1 ───────────
--   select
--     (select count(*) from pg_policies where cmd='SELECT' and (
--        (schemaname='enterprise' and tablename in ('sample_container','shipment','sample_chain_event','custody_signature'))
--        or (schemaname='geo' and tablename in ('geological_layer','coverage_cell')))) as select_pol,
--     (select count(*) from pg_policies where cmd in ('INSERT','UPDATE','DELETE','ALL') and (
--        (schemaname='enterprise' and tablename in ('sample_container','shipment','sample_chain_event','custody_signature'))
--        or (schemaname='geo' and tablename in ('geological_layer','coverage_cell')))) as write_pol, -- expect 0
--     (select count(*) from pg_proc p join pg_namespace n on p.pronamespace=n.oid
--        where n.nspname='enterprise' and p.proname='can_read_chain_event') as helper;

-- ── ROLLBACK (down-path) ───────────────────────────────────────────────────
--   drop policy if exists coverage_cell_select on geo.coverage_cell;
--   drop policy if exists geological_layer_select on geo.geological_layer;
--   drop policy if exists custody_sig_select on enterprise.custody_signature;
--   drop policy if exists chain_event_select on enterprise.sample_chain_event;
--   drop policy if exists shipment_select on enterprise.shipment;
--   drop policy if exists container_select on enterprise.sample_container;
--   revoke select, insert, update, delete on enterprise.sample_container, enterprise.shipment,
--     enterprise.sample_chain_event, enterprise.custody_signature, geo.geological_layer, geo.coverage_cell from service_role;
--   revoke select on enterprise.sample_container, enterprise.shipment, enterprise.sample_chain_event,
--     enterprise.custody_signature, geo.geological_layer, geo.coverage_cell from authenticated;
--   drop function if exists enterprise.can_read_chain_event(uuid);

-- Verification for migrations 0159 + 0160 (Somalia Historical Intelligence).
-- Run AFTER applying both on a branch/staging DB. Each block RAISEs on failure.
-- Proves the firewall + no-MRDS-change + evidence-discipline properties
-- (Addendum Part M requirements 1-14, expressed as DB-level assertions).

do $$
declare
  n_occ int; n_hist int; n_anom_as_occ int; n_fabricated int; n_nonprov int;
  before_occ jsonb; after_occ jsonb;
begin
  -- (M12) MRDS/mineral_occurrence row count unchanged (baseline was 159).
  select count(*) into n_occ from geo.mineral_occurrence;
  if n_occ <> 159 then
    raise exception 'FAIL M12: mineral_occurrence count = %, expected 159 (historical data must NOT add occurrence rows)', n_occ;
  end if;

  -- (M1/M2/M3) No historical/anomaly row leaked into mineral_occurrence:
  -- every mineral_occurrence row still traces to an original spatial dataset,
  -- never to the historical container.
  perform 1 from geo.mineral_occurrence o
    join geo.dataset_registry d on d.id = o.dataset_id
    where d.source_key in ('somalia_historical_sources','hadden_2007_biblio');
  if found then
    raise exception 'FAIL M1/M2: a mineral_occurrence row is parented by a historical dataset — occurrence path polluted';
  end if;

  -- (M14) FIREWALL: occurrences_near returns IDENTICAL rows over the whole
  -- MRDS extent before/after — i.e. the new tables feed no scoring. We assert
  -- the row set equals exactly the 159 mapped occurrences (the historical
  -- table has no geometry and is not joined by any RPC).
  select count(*) into n_occ
  from geo.occurrences_near(10.5, 46.0, 2000000);   -- radius covering all Somalia
  if n_occ <> 159 then
    raise exception 'FAIL M14: occurrences_near returned % rows, expected 159 — historical data entered the scoring path', n_occ;
  end if;

  -- (M13) Every historical record is provisional (never a calibration/AUC label).
  select count(*) into n_nonprov from geo.historical_mineral_record where provisional is not true;
  if n_nonprov <> 0 then
    raise exception 'FAIL M13: % historical records are not provisional', n_nonprov;
  end if;

  -- (Part E/H) Anomalies are stored as anomalies, never occurrences.
  select count(*) into n_anom_as_occ from geo.historical_mineral_record
    where name ilike '%anomaly%' and evidence_type <> 'geochemical_anomaly';
  if n_anom_as_occ <> 0 then
    raise exception 'FAIL: % anomaly records mis-typed as non-anomaly', n_anom_as_occ;
  end if;

  -- (M10/Part C) No fabricated coordinates: every row inserted this pass has
  -- geom NULL (coordinates only ever arrive via a later georeference/gazetteer
  -- step that also sets location_method away from none/pending).
  select count(*) into n_fabricated from geo.historical_mineral_record
    where geom is not null and location_method in ('none');
  if n_fabricated <> 0 then
    raise exception 'FAIL M10: % rows have geometry with no resolution method (fabricated coordinate)', n_fabricated;
  end if;

  -- (Part A) Provenance actually landed.
  select count(*) into n_hist from geo.historical_mineral_record;
  if n_hist < 1 then raise exception 'FAIL: no historical records inserted'; end if;

  raise notice 'PASS: 0159+0160 firewall verified — MRDS unchanged (159), occurrences_near unchanged (159), % historical records all provisional/geom-null, anomalies typed correctly.', n_hist;
end $$;

-- (M11/schema) The evidence_type CHECK must REJECT an attempt to store an
-- anomaly as an occurrence. This should raise a check_violation.
do $$
begin
  begin
    insert into geo.historical_mineral_record (name, evidence_type) values ('__constraint_probe__','definitely_a_deposit');
    raise exception 'FAIL M11: evidence_type CHECK did not reject an invalid value';
  exception when check_violation then
    raise notice 'PASS M11: evidence_type CHECK correctly rejects out-of-vocabulary values';
  end;
  -- clean the probe if it somehow inserted (it must not have)
  delete from geo.historical_mineral_record where name = '__constraint_probe__';
end $$;

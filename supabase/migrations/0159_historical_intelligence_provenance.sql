-- 0159 — Somalia Historical Mineral Intelligence: PROVENANCE ONLY (Phase 2).
--
-- SAFETY (audited before writing — see the integration dry-run report):
--   * This migration inserts ONLY into geo.dataset_registry + geo.knowledge_source.
--   * geo.occurrences_near() (0058) — the ONLY read path that feeds the
--     TargetingEngine's occurrence evidence — selects rows FROM
--     geo.mineral_occurrence and JOINs dataset_registry. A dataset_registry row
--     with NO child mineral_occurrence rows is therefore NEVER returned by that
--     RPC and CANNOT change any prospectivity score. Verified by regression
--     test enterprise_provenance_no_score_impact (added separately).
--   * geo.knowledge_near() reads geo.geological_knowledge (0 rows, untouched
--     here) JOINed to knowledge_source — a knowledge_source row with no child
--     geological_knowledge row is likewise never returned.
--   * NO existing row is modified. NO MRDS row is touched. NO commodity profile
--     is touched. NO scoring code, RPC signature, or Edge Function changes.
--
-- IDEMPOTENT: guarded by WHERE NOT EXISTS on source_key / (dataset_id,title);
--   safe to re-run. REVERSIBLE: see the down-migration block at the end.
--
-- EVIDENCE DISCIPLINE: every source records, in metadata, whether it was
--   actually RECOVERED (a file we hold/read) or only REFERENCED_BUT_NOT_RECOVERED
--   (a citation we found). We never claim recovery we didn't achieve.

-- ── 1. Dataset-level record for the recovered master bibliography ────────────
insert into geo.dataset_registry (source_key, title, category, version, license, source_url, crs, metadata)
select 'hadden_2007_biblio',
       'Hadden, R.L. 2007 — The Geology of Somalia: a Selected Bibliography of Somalian Geology, Geography and Earth Science',
       'reference', '2007', 'US Government — UNCLASSIFIED / UNLIMITED',
       'https://arcadia.sba.uniroma3.it/handle/2307/3227',
       null,
       jsonb_build_object(
         'organization','US Army Corps of Engineers, Topographic Engineering Center',
         'access_class','archival_public',
         'recovery_status','recovered',
         'source_confidence','tertiary',
         'note','Master citation hub; ~3,600 references. Full text recovered and searched. Not a spatial dataset — carries no occurrence geometry, hence dataset_registry only, no mineral_occurrence children.',
         'ingest_batch','historical_intelligence_2026_09')
where not exists (select 1 from geo.dataset_registry where source_key = 'hadden_2007_biblio');

-- A second dataset record groups the newly-surfaced primary/secondary sources
-- as a logical collection (so their knowledge_source rows have a parent).
insert into geo.dataset_registry (source_key, title, category, version, license, source_url, crs, metadata)
select 'somalia_historical_sources',
       'Somalia Historical Mineral-Exploration Sources (recovered + referenced, 2026-09 pass)',
       'reference', '2026.09', 'mixed (see per-source access_class)', null, null,
       jsonb_build_object(
         'access_class','mixed',
         'recovery_status','mixed',
         'note','Container for individual primary/secondary sources surfaced via Hadden 2007 and public web. Each child knowledge_source carries its own access_class + recovery_status.',
         'ingest_batch','historical_intelligence_2026_09')
where not exists (select 1 from geo.dataset_registry where source_key = 'somalia_historical_sources');

-- ── 2. knowledge_source rows — one per real source (recovered or referenced) ─
-- helper: resolve the container dataset id at insert time.
with ds as (select id from geo.dataset_registry where source_key = 'somalia_historical_sources')
insert into geo.knowledge_source
  (dataset_id, source_type, title, authors, organization, publication_year, exploration_period, language, uri, page_count, reference, metadata)
select ds.id, v.source_type, v.title, v.authors, v.organization, v.publication_year, v.exploration_period,
       v.language, v.uri, v.page_count::integer, v.reference, v.metadata
from ds, (values
  -- (source_type, title, authors, org, pub_year, expl_period, lang, uri, page_count, reference, metadata)
  ('report','Plan of Dalan Cassiterite Prospect (pit and trench diagrams) — Appendix to Greenwood 1960 Las Khoreh–Elayu report',
    'Directorate of Overseas Surveys; Stewart, J.A.B. (appendix)','Directorate of Overseas Surveys, Tolworth, Surrey',
    1960,'1954-1961','en',null,null,
    'Plan of Dalan Cassiterite Prospect, 1960; with pit and trench diagrams (Illustrations B & C to Appendix 1 of Greenwood 1960).',
    jsonb_build_object('access_class','historical_scanned','recovery_status','referenced_but_not_recovered','commodity','tin',
      'relation','same_locality_as_mrds:Dalan Prospect (geo.mineral_occurrence, Tin, Greenwood 1960)',
      'georef_candidate',true,'evidence_type','mapped_occurrence','note','The OCCURRENCE is already in MRDS. NEW value = trench/pit-level map detail; queued for georeferencing, not re-inserted as an occurrence.')),
  ('report','Gellatly, D.C. 1961 — The Geology of the Area Around Dalan, Near Elayu (report ref DCG/7)',
    'Gellatly, D.C.','Somali Republic / Somaliland Geological Survey',1961,'1961','en',null,null,
    'Gellatly, D.C., 1961, The Geology of the Area Around Dalan, Near Elayu; ref DCG/7.',
    jsonb_build_object('access_class','referenced_but_not_recovered','recovery_status','referenced_but_not_recovered','commodity','tin',
      'relation','primary source behind mrds:Dalan Prospect','evidence_type','mapped_occurrence')),
  ('journal','Jobstraibizer, P.G. 1993 — Black Heavy-Mineral Beach Sands from Batalaleh (Berbera, N. Somalia)',
    'Jobstraibizer, P.G.','GEOSOM-87 / Somali National University',1993,'1987-1993','en',null,null,
    'Jobstraibizer, P.G., 1993, Black Heavy-Mineral Beach Sands from Batalaleh (Berbera, N. Somalia); GEOSOM 87.',
    jsonb_build_object('access_class','archival_public','recovery_status','referenced_but_not_recovered',
      'commodity','titanium;iron;ree','heavy_minerals','ilmenite;magnetite;monazite;zircon',
      'evidence_type','sampled_occurrence','note','No equivalent in MRDS (Ti/ilmenite = 0). Genuinely NEW placer occurrence; held in historical_mineral_record, NOT scored.')),
  ('report','Forman, H.D. 1963 — A Photogeological Interpretation of the Bur Region, Somali Republic',
    'Forman, H.D.',null,1963,'1963','en',null,null,
    'Forman, H.D., 1963, A Photogeological Interpretation of the Bur Region, Somali Republic.',
    jsonb_build_object('access_class','referenced_but_not_recovered','recovery_status','referenced_but_not_recovered',
      'evidence_type','geological_indication','georef_candidate',true,'note','Photogeology map of the Bur basement mineral province.')),
  ('report','Mineral Resources Pamphlet No. 1 (1954) — Gypsum & Anhydrite, Somaliland Protectorate',
    'Somaliland Protectorate Geological Survey','Somaliland Protectorate Geological Survey',1954,'1947-1956','en',
    'https://earthwise.bgs.ac.uk/index.php/Somaliland_Protectorate_%E2%80%94_Colonial_Geological_Surveys_1947%E2%80%931956',null,
    'Somaliland Protectorate Geological Survey, 1954, Mineral Resources Pamphlet No. 1 (gypsum & anhydrite).',
    jsonb_build_object('access_class','referenced_but_not_recovered','recovery_status','referenced_but_not_recovered','commodity','gypsum',
      'locality_hint','9 and 25 miles from Berbera harbour','evidence_type','historical_claim',
      'note','Distinct from the single MRDS gypsum point; distance-from-Berbera locality is georef_candidate.')),
  ('report','China Well Drilling Team (Hargeysa) 1983 — Report on Geological [prospecting], Somali Democratic Republic',
    'China Well Drilling Team, Hargeysa','China Well Drilling Team',1983,'1983','en',null,null,
    'China Well Drilling Team, Hargeysa, 1983, Report on Geological prospecting, Somali Democratic Republic.',
    jsonb_build_object('access_class','referenced_but_not_recovered','recovery_status','referenced_but_not_recovered',
      'foreign_program','China','evidence_type','reference_only','note','Chinese foreign-survey angle — entirely new to the catalogue; no public digital copy located.')),
  ('report','China Water Prospecting (Beijing) 1971 — Reports of Prospecting and Drilling',
    'China Water Prospecting, Beijing','China Water Prospecting',1971,'1971','en',null,null,
    'China Water Prospecting, Beijing, 1971, Reports of Prospecting and Drilling.',
    jsonb_build_object('access_class','referenced_but_not_recovered','recovery_status','referenced_but_not_recovered',
      'foreign_program','China','evidence_type','reference_only')),
  ('field_report','Global Initiative Against Transnational Organized Crime — Milxo gold-rush field study',
    'Global Initiative Against Transnational Organized Crime','Global Initiative',2025,'2016-2025','en',
    'https://globalinitiative.net/analysis/somali-gold-rush-milxo-mining/',null,
    'Global Initiative, Somali gold rush: Milxo and the ungoverned mining frontier.',
    jsonb_build_object('access_class','public_hard_to_find','recovery_status','recovered','commodity','gold',
      'evidence_type','artisanal_working','locality','Milxo, NE Somalia (SSC-Khatumo / Sanaag-Sool, near Golis Mts)',
      'note','20 mining sites / 18 commercial entities. MRDS gold = 0. NEW; held in historical_mineral_record, NOT scored.')),
  ('news','Somaliland Standard — The Gold Producing Potential of Somaliland (A. Tahir, Somaliland MoEM)',
    'Tahir, Ahmed','Somaliland Ministry of Energy & Minerals',2020,'2020s','en',
    'https://somalilandstandard.com/the-gold-producing-potential-of-somaliland/',null,
    'Tahir, A., The Gold Producing Potential of Somaliland, Somaliland Standard.',
    jsonb_build_object('access_class','public_hard_to_find','recovery_status','recovered','commodity','gold',
      'localities','Irshida/Cirshida (Sanaag, greenstone belt, nuggets, shear zones); Mait; Abdul Qadr & Arabsiyo (geochemical anomalies)',
      'evidence_type','mixed:sampled_occurrence+geochemical_anomaly',
      'note','Irshida/Mait = occurrence-level; Abdul Qadr/Arabsiyo = ANOMALY only, must not become occurrences.')),
  ('company','Asawira Resources — active gold explorer, Somaliland + Puntland (Arabian-Nubian Shield)',
    'Asawira Resources','Asawira Resources',2024,'2020s','en','https://asawira.so/',null,
    'Asawira Resources company website (gold, ~500 km2 ANS coverage, Boorame to Ras Asayr).',
    jsonb_build_object('access_class','company_public','recovery_status','recovered','commodity','gold',
      'evidence_type','reference_only','note','Company existence + concession framing recovered; NO coordinates, assays, or survey data published.')),
  ('dataset','Getech — Somalia gravity + magnetic compilation (commercial/licensed)',
    'Getech','Getech',2026,null,'en','https://getech.com/country-focus/africa/somalia-country-focus/',null,
    'Getech Somalia country-focus: compiled onshore gravity + reprocessed magnetic surveys (commercial).',
    jsonb_build_object('access_class','restricted_private','recovery_status','referenced_but_not_recovered',
      'evidence_type','geophysical_compilation','note','Proves historical airborne-magnetic + gravity coverage of Somalia exists; underlying original surveys not named, compilation is licensed — not importable.'))
) as v(source_type, title, authors, organization, publication_year, exploration_period, language, uri, page_count, reference, metadata)
where not exists (
  select 1 from geo.knowledge_source ks
  join geo.dataset_registry d on d.id = ks.dataset_id
  where d.source_key = 'somalia_historical_sources' and ks.title = v.title);

-- ── DOWN (manual, if ever needed) ───────────────────────────────────────────
-- delete from geo.knowledge_source ks using geo.dataset_registry d
--   where ks.dataset_id = d.id and d.source_key = 'somalia_historical_sources';
-- delete from geo.dataset_registry where source_key in ('hadden_2007_biblio','somalia_historical_sources');

# GeoContext P2 — Geological Source Corpus Catalog (Discovery Phase)

**Status:** Discovery complete — awaiting approval. **No knowledge extracted, no DB
populated, no embeddings built** (per P2 rules). This is a curated catalog of real,
publicly/legitimately accessible geological sources with verified URLs.

**Honesty note on scope:** entries below are **sources discovered via web research**,
not files downloaded. Genuine **file checksums, byte-level duplicate detection, and
per-file quality scores require an actual download/collection step** (permission-gated,
its own micro-phase). Nothing here is fabricated — unknown fields are marked `—`.
"Duplicate analysis" and "quality assessment" below are at the logical/source level.

---

## 1. Corpus catalog

### A. Somalia-specific — primary geology & mineral sources
| # | Title / collection | Publisher | Year | Types | Coverage | Access URL | License |
|---|---|---|---|---|---|---|---|
| S1 | **Digitized Geological Map of Somalia 1:1,500,000 (Abbate et al.)** | UNESCO IHP-WINS | 1994/digitized | GIS (polygons) | National geology, lithology, formations, structure | https://ihp-wins.unesco.org/dataset/geological-map-of-somalia-1-1-500-000 | UNESCO open (verify) |
| S2 | **Greenwood — Preliminary evaluation of the nonfuel mineral potential of Somalia (OFR 82-788)** | USGS | 1982 | PDF report | National, multi-commodity, deposit types | https://pubs.usgs.gov/publication/ofr82788 · PDF https://pubs.usgs.gov/of/1982/0788/report.pdf | US Gov public domain |
| S3 | **Mineral & Groundwater Survey, Somalia (UNDP)** | UN / UNDP | 1965–1975 | Reports, geochem stream-sediment | N Somalia; Pb/Zn/Cu/Ni anomalies | https://digitallibrary.un.org/record/724138 · https://digitallibrary.un.org/record/724150 | UN |
| S4 | **IUREP Orientation Phase Mission — Somalia (uranium)** | IAEA / OSTI | 1983 | PDF report | National uranium potential | https://inis.iaea.org/records/3cn9a-sc519 · https://www.osti.gov/etdeweb/biblio/21219330 | IAEA/INIS |
| S5 | **Surficial uranium deposits in Somalia** (+ TECDOC-322) | IAEA INIS | 1984 | PDF | Mudugh/Dusa Mareb–El Bur calcrete U | https://inis.iaea.org/records/178pq-6pk04 · https://www-pub.iaea.org/MTCD/Publications/PDF/te_322_web.pdf | IAEA |
| S6 | **UDEPO — Somalia country file** | IAEA | current | PDF/data | Uranium deposits | https://infcis.iaea.org/udepo/Resources/Countries/Somalia.pdf | IAEA |
| S7 | **First Report on the Geology and Mineral Resources of British Somaliland (Farquharson)** | Colonial Geol. Survey | 1924 | Digitized book | N Somaliland | https://archive.org/details/FirstReportGeologyBritishSomaliland | Public domain |
| S8 | **Somaliland Protectorate — Colonial Geological Surveys 1947–1956** | BGS Earthwise | 1947–56 | Reports, 1:125k maps (Berbera sheet) | N Somaliland | https://earthwise.bgs.ac.uk/index.php/Somaliland_Protectorate_%E2%80%94_Colonial_Geological_Surveys_1947%E2%80%931956 | BGS/OGL (verify) |
| S9 | **1:125,000 Somaliland Protectorate geological survey (map set)** | Directorate of Overseas Surveys | 1950s | Historical maps | N Somaliland sheets | https://searchworks.stanford.edu/view/11870448 · https://geodata.lib.berkeley.edu/catalog/stanford-nr366rs0962 | — |
| S10 | **Report on general survey of British Somaliland 1944** | Military Govt / LoC | 1945 | Digitized report | Economic/recon survey | https://www.loc.gov/item/47020727/ | Public domain |
| S11 | **FAO SWALIM — Geology & Mineral Resources of Somalia** | FAO SWALIM | current | PDF + geoportal (GeoJSON/SHP/CSV) | National land/water/geology | https://faoswalim.org/resources/Land/Geology_Mineral_Resources_Somalia/Geology.pdf · portal https://spatial.faoswalim.org/ | FAO (verify) |
| S12 | **Hydrogeology of Somalia / Africa Groundwater Atlas** | BGS Earthwise | current | Wiki + literature archive | National hydrogeology + refs | https://earthwise.bgs.ac.uk/index.php/Hydrogeology_of_Somalia | BGS/OGL |
| S13 | **World Bank — Somalia Groundwater Assessment** | World Bank | 2021 | PDF | National groundwater | https://documents1.worldbank.org/curated/en/099615012012129914/pdf/P1749940c70d5d09008a3203ad9eeb97d1a.pdf | World Bank open |
| S14 | **USGS — Mineral Industry of Somalia (yearbook chapters)** | USGS NMIC | 2017–2024 | PDF | Commodity/production | https://www.usgs.gov/centers/national-minerals-information-center/somalia · https://www.usgs.gov/media/files/mineral-industry-somalia-2017-18-pdf | US Gov public domain |
| S15 | **UN ESCWA — Somalia's Mining Sector** | UN ESCWA | recent | PDF | Sector overview | https://www.unescwa.org/sites/default/files/event/materials/06-Somali%20minerals%20sector.pdf | UN |
| S16 | **Geological Map of Ethiopia and Somalia 1:2,000,000 (Merla, Abbate, Azzaroli et al.)** | CNR Italy / Pergamon | 1973/1979 | Map + 95pp comment | Regional (Horn of Africa) | (ResearchGate ref; print via CNR/Univ. Firenze) | © CNR (permissions needed) |
| S17 | **Smithsonian — Mohr, Catalog of Ethiopian/Horn geology (bibliography)** | Smithsonian | 1960s | PDF bibliography | Regional literature index (discovery seed) | https://www.govinfo.gov/content/pkg/GOVPUB-SI-PURL-LPS116041/pdf/GOVPUB-SI-PURL-LPS116041.pdf | US Gov |

### B. International portals & datasets (global/Africa, incl. Somalia)
| # | Source | Holds | Types | Access |
|---|---|---|---|---|
| I1 | **USGS MRDS** | worldwide metallic/nonmetallic occurrences (name, commodity, deposit type, host, production, refs) | SHP/CSV/XML | https://mrdata.usgs.gov/mrds/ |
| I2 | **USGS Mineral Resources Online Spatial Data — Africa** | Africa/Somalia occurrence catalog | SHP/WMS | https://mrdata.usgs.gov/catalog/science.php?thcode=1&term=fLD50 |
| I3 | **USGS — GIS for Mineral Industries & Infrastructure of Africa** | continent-wide mineral/infrastructure GIS | SHP/GeoTIFF | https://data.usgs.gov/datacatalog/data/USGS:607611a9d34e018b3201cbbf |
| I4 | **OneGeology portal** | national geological maps (1:1M, some 1:50k) | WMS/WFS | https://portal.onegeology.org/ |
| I5 | **BRGM — Geological Map of Africa 1:10,000,000 (CGMW-BRGM)** | continental geological units + faults | WMS/WFS/GeoNetwork | https://www.brgm.fr/en/reference-completed-project/new-edition-110000000-geological-map-africa |
| I6 | **BGS OpenGeoscience + Publications Viewer** | 400+ datasets, scanned reports/maps, Africa Groundwater Atlas | maps/data/PDF | https://www.bgs.ac.uk/geological-data/opengeoscience/ · https://webapps.bgs.ac.uk/data/publications/pubs.cfc?method=viewHome |
| I7 | **IAEA INIS repository** | nuclear/geoscience literature (uranium, radiometrics) | PDF | https://inis.iaea.org/ |

### C. Pan-African programmes (discovery + future partnerships)
| # | Source | Role | Access |
|---|---|---|---|
| P1 | **OAGS — Organisation of African Geological Surveys** | national-survey network; data-sharing | https://oagsafrica.org/ |
| P2 | **PanAfGeo (EuroGeoSurveys × OAGS)** | pan-African geoscience training + data | https://panafgeo.eurogeosurveys.org/about/ |
| P3 | **AMGI — African Minerals Geoscience Initiative (AU/GSAf/OAGS)** | single African geodata repository (emerging) | (AU Commission) |
| P4 | **GIRAF — Geoscience Information in Africa Network** | pan-African geoscience info network | (via EGS/BGR) |

---

## 2. Approval-gate summary

**Total concrete sources cataloged:** **28** distinct entries — 17 Somalia-specific
(S1–S17), 7 international portals/datasets (I1–I7), 4 pan-African programmes (P1–P4).
Several are *collections* containing many documents (e.g., MRDS ≈ thousands of records;
BGS Publications Viewer; INIS Somalia set), so document-level counts will be far higher
after the collection step.

**Source categories covered:** national surveys (USGS, BGS, BRGM, GEOSOM legacy),
international orgs (UNESCO, IAEA, UNDP, UN, World Bank, FAO, ESCWA), historical/colonial
(British Somaliland surveys, Italian CNR maps), digital archives (Internet Archive, LoC,
Stanford, Berkeley), map portals (OneGeology, BRGM CGMW), mineral databases (MRDS,
UDEPO), pan-African programmes. ✅ All requested categories represented.

**Geographic coverage:** National Somalia + Somaliland/Puntland; Horn-of-Africa
regional; continental Africa; global (MRDS/OneGeology). Strong for N Somaliland
(colonial legacy); thinner for S/central Somalia at large scale.

**Time coverage:** 1924 (Farquharson) → 1944–56 (colonial) → 1965–84 (UNDP/IAEA/
Greenwood/Italian) → 1994 (Abbate map) → 2017–2024 (USGS/World Bank/FAO). ~100-year span.

**Data gaps:**
- **GEOSOM primary archive** (Mogadishu) — the national survey's own borehole logs,
  unpublished exploration & lab reports are largely **not digitized/online**; likely need
  direct institutional contact.
- **Soviet expedition reports** — referenced but few located online in English; likely in
  Russian archives/Rosgeo (translation + sourcing needed).
- **Company exploration reports** (oil/mineral) — mostly proprietary; only fragments public.
- **Large-scale (>1:250k) modern coverage** of southern/central Somalia — sparse.
- **Geophysics/airborne & drill-core** — very limited public availability.

**Quality assessment (source-level):**
- **Tier 1 (authoritative, structured, directly ingestible):** S1 (UNESCO GIS), S2, I1–I3
  (USGS/MRDS), I4–I5 (OneGeology/BRGM), S11 (SWALIM geoportal).
- **Tier 2 (authoritative PDF, needs extraction):** S3–S6, S12–S15, I6–I7.
- **Tier 3 (historical, high value, OCR needed):** S7–S10, S16, S17.

**Duplicate analysis (logical level):** overlaps to de-dupe at collection time — Greenwood
OFR 82-788 appears via USGS + secondary citations; the Abbate 1:1.5M map appears via
UNESCO IHP-WINS (S1) and secondary refs; Somaliland colonial maps span BGS/Stanford/
Berkeley (same sheets, different scans → keep best-resolution). Byte-level dedup deferred
to the download step.

**Recommended ingestion order (for the later pipeline, not now):**
1. **S1 UNESCO geological map** (GIS) → `geo.geological_layer` (spatial backbone).
2. **I1–I3 MRDS / USGS Africa** → `geo.mineral_occurrence` (occurrence backbone).
3. **S2 Greenwood OFR 82-788** → knowledge pipeline (highest-value structured national eval).
4. **S3 UNDP geochem** → geochemical anomalies knowledge.
5. **S4–S6 IAEA uranium** → commodity/knowledge.
6. **S12–S13 hydrogeology** (context) → knowledge.
7. **S7–S10 colonial historical** (OCR) → knowledge.
8. **S16 Italian regional map** (permissions) → geology context.
9. Ontology/association seed refined from the above.

---

**STOP — awaiting approval.** No extraction/DB/embeddings until approved. On approval,
the next gated micro-step is **physical collection** (download Tier-1/Tier-2 items,
compute checksums, byte-level dedup, per-file quality scoring) — which requires
download permission — *then* the Knowledge Extraction Pipeline.

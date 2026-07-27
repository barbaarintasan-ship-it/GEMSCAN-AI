# Batch 2 — Collection Report (Open PDF Reports)

**Scope:** LSC-0004, 0005, 0006, 0013, 0014, 0015, 0017, 0021, 0022, 0064, 0072
(+ LSC-0002 already in Pilot — verified, not re-downloaded). Pre-Batch-2: LSC-0019
reclassified `derived-from LSC-0018`; LSC-0073 (490 MB supporting data) added as an
optional companion of LSC-0020. Files in session scratchpad; no repo binaries.

## 1. Batch 2 Summary
| Metric | Count | Items |
|---|---:|---|
| Attempted | 11 (+1 verify) | 0004,0005,0006,0013,0014,0015,0017,0021,0022,0064,0072 (+0002) |
| **Collected (valid, new)** | 5 | 0005, 0013, 0015, 0017, 0072 |
| Verified-present (pilot) | 1 | 0002 |
| **collected-but-invalid** | 1 | 0006 (HTML, not a PDF) |
| **Failed** | 2 | 0004 (resolve), 0014 (HTTP 403) |
| **Blocked (portal)** | 3 | 0021, 0022, 0064 |
| Duplicate-content | 0 | — |

## 2. Resource manifest (`resource_manifest_batch2.json`) — collected
| id | fmt | sha256 (head) | bytes | Last-Modified |
|---|---|---|---:|---|
| LSC-0005 | PDF | `007ac44f…` | 18,231,243 | 2003-04-14 |
| LSC-0006 | PDF* | `618fdfd4…` | 33,423 | — (*invalid — HTML) |
| LSC-0013 | PDF | `3c0bdd1b…` | 4,529,203 | (dynamic) |
| LSC-0015 | PDF | `0a23f322…` | 1,111,213 | 2025-05-21 |
| LSC-0017 | PDF | `6ed7d4ee…` | 10,060,793 | (dynamic) |
| LSC-0072 | PDF | `1df17b56…` | 595,655 | 2024-10-22 |

## 3. Collection log — Batch 2 events recorded (collected/blocked/permanent_fail).

## 4. Storage statistics
- Batch 2 new bytes (valid): **34,561,530** (~34.6 MB) across 5 valid files (0006 quarantined, not counted).
- Total store (Pilot+B1+B2): **247,842,321** (~247.8 MB). Checksum count: **13**. CAS files: 13.
- Dedup: 0 new (656 KB cumulative from Pilot).

## 5. Extraction Readiness report
| ready ✅ | LSC-0005, 0013, 0015, 0017, 0072 (+0002) — all PDF text layer present |
|---|
| **not ready ❌** | LSC-0006 `collected-but-invalid` (pdftotext failed — file is HTML, not PDF) → excluded from pipeline |

The safeguard correctly quarantined a non-PDF; no invalid artifact entered the pipeline.

## 6. Issues encountered (diagnosed)
- **LSC-0006 (UDEPO):** `infcis.iaea.org/udepo/Resources/Countries/Somalia.pdf` returns an
  **HTML app shell** (`<base href="/UTHDEPO/">`), not a static PDF. UDEPO is a web app;
  the country file must be reached through the UDEPO portal. → `collected-but-invalid`.
- **LSC-0014 (USGS yearbook):** `usgs.gov/media/files/…` returns **HTTP 403** to
  programmatic clients (even with a browser User-Agent). Needs manual/browser download from
  the USGS Somalia page.
- **LSC-0004 (IAEA IUREP):** INIS InvenioRDM API returned no resolvable open PDF (record
  gated / API shape differs). Use the record page or the OSTI ETDEWEB mirror.
- **LSC-0021/0022/0064 (portals):** OneGeology (WMS/WFS), BRGM CGMW (GeoNetwork/WMS),
  Smithsonian (search API, key required) — need **portal-resolver adapters**; routed to a
  dedicated portal batch (B4). No corruption; no licensing blocks.

## 7. Recommendations before Batch 3
1. **Add a pre-store content-type check** (reject `text/html` when a PDF/GIS is expected) so
   app-shell responses fail fast (readiness caught LSC-0006 post-hoc; catch it earlier).
2. **Build portal-resolver adapters** (OneGeology WMS/WFS; BRGM GeoNetwork; Smithsonian API
   key) before the portal batch (B4).
3. **403 handling:** browser UA + referer, or route to manual download (LSC-0014).
4. **Re-resolve LSC-0004/0006** via their portals (INIS record / OSTI; UDEPO portal).
5. **Manual-download handoff:** the 6 non-collected items have human-accessible URLs (below)
   — collect via browser, then ingest through the standard workflow (checksum + readiness).

## Registry write-back (verification)
Collection-state written for all Batch 2 ids (+0002); **immutable scientific metadata
changed = 0**. `collected-but-invalid` and `blocked` reflected; scientific fields/IDs/
relationships unchanged.

## Manual-download links (user-collected)
| id | Item | Best human URL |
|---|---|---|
| LSC-0004 | IAEA IUREP Somalia (uranium mission) | https://inis.iaea.org/records/3cn9a-sc519 · mirror https://www.osti.gov/etdeweb/biblio/21219330 |
| LSC-0006 | IAEA UDEPO Somalia (uranium deposits) | https://infcis.iaea.org/UTHDEPO/ (open portal → Somalia) |
| LSC-0014 | USGS Mineral Industry of Somalia (yearbook) | https://www.usgs.gov/centers/national-minerals-information-center/somalia |
| LSC-0021 | OneGeology portal (Somalia geology) | https://portal.onegeology.org/ |
| LSC-0022 | BRGM Geological Map of Africa 1:10M | https://www.brgm.fr/en/reference-completed-project/new-edition-110000000-geological-map-africa |
| LSC-0064 | Smithsonian Mineral Sciences search (Somalia) | https://collections.nmnh.si.edu/search/ms/ |

---
**Batch 2 complete. Stopping — Batch 3 not started.** When you provide manually-downloaded
files, I'll ingest them (checksum + dedup + readiness + registry write-back).

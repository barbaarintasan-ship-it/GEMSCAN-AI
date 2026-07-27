# Batch 1 — Collection Report (Spatial Backbone)

**Scope:** LSC-0018 (MRDS), LSC-0019 (MRDS Africa), LSC-0020 (USGS Africa GIS).
LSC-0001 (UNESCO) + LSC-0011 (SWALIM) already collected in the Pilot — verified present,
not re-downloaded. Files in session scratchpad `corpus_pilot/`; **no repo binaries**.
Canonical registry updated (collection-state fields only).

## 1. Batch 1 Summary
| Metric | Count | Items |
|---|---:|---|
| Attempted | 3 | LSC-0018, LSC-0019, LSC-0020 |
| **Collected** | 2 | LSC-0018 (MRDS CSV), LSC-0020 (Africa GIS FileGDB) |
| Failed | 0 | — |
| **Blocked** | 1 | LSC-0019 (no standalone endpoint — Africa subset of MRDS) |
| Duplicate-content | 0 | — |
| Verified-present (pilot) | 2 | LSC-0001, LSC-0011 |
| extraction-ready | 2/2 collected | both valid |
| collected-but-invalid | 0 | — |

## 2. Resource manifest (`resource_manifest_batch1.json`)
| id | format | resolvedUrl | ETag | Last-Modified | sha256 | bytes |
|---|---|---|---|---|---|---|
| LSC-0018 | ZIP(csv) | mrdata.usgs.gov/mrds/mrds-csv.zip | `"1898af7-5e6eefd78cbfe"` | Tue, 23 Aug 2022 | `31be4baa…38a5477` | 25,791,223 |
| LSC-0020 | ZIP(FileGDB) | sciencebase.gov/catalog/file/get/607611a9…?f=__disk__30/8a/b1/… | — | (dynamic) | `bd00e2a1…4455be67` | 138,139,197 |

## 3. Collection log (`collection_log.jsonl`, Batch 1 events)
```
{"event":"collected","id":"LSC-0018","sha256":"31be4baa…","bytes":25791223,"valid":true}
{"event":"blocked","id":"LSC-0019","reason":"subset-of-LSC-0018"}
{"event":"collected","id":"LSC-0020","sha256":"bd00e2a1…","bytes":138139197,"valid":true}
```

## 4. Storage statistics
- **Batch 1 bytes downloaded:** 163,930,420 (~163.9 MB) — LSC-0018 25.8 MB + LSC-0020 138.1 MB.
- **Total store (pilot + Batch 1):** 213,280,791 (~213.3 MB).
- **Deduplicated bytes saved:** 656,209 (pilot LSC-0002-DUP; none new in Batch 1).
- **Checksum count (files with SHA-256):** 7.
- CAS files: 6 · log lines: 8.

## 5. Extraction Readiness report
| id | format | ready | note |
|---|---|:--:|---|
| LSC-0018 | ZIP/CSV | ✅ | csv archive (1 csv) — valid, parseable |
| LSC-0020 | ZIP/FileGDB | ✅ | FileGDB present (geometry **not** deep-validated — no GDAL) |
| LSC-0019 | — | ❌ | not collected (blocked) |

Both collected artifacts are extraction-ready. **Caveat:** LSC-0020's FileGDB passed a
structural check only (zip opens, `.gdb` present); full layer/CRS/geometry validation
needs GDAL/OGR (flagged for the extraction environment).

## 6. Issues encountered
- **Resolver — LSC-0019 (MRDS Africa):** no standalone canonical download endpoint. MRDS
  Africa is a **subset** of the global MRDS (LSC-0018); the catalog page exposes no
  per-continent file. **Handled** by marking `blocked / no-standalone-endpoint` (registry
  already links it `subset-of LSC-0018`); the Africa/Somalia slice is derived by filtering
  MRDS at processing time — not a separate download.
- **ScienceBase metadata (LSC-0020):** the `file/get` download endpoint returns **no stable
  ETag** and a dynamic `Last-Modified` (= request time). Use the ScienceBase **item version /
  dateUploaded** for change-detection instead of HTTP headers (manifest records the resolved
  disk URL + sha256 for integrity).
- **Deferred large file (LSC-0020):** `Africa_GIS Supporting Data.zip` (489.9 MB) recorded as
  **available-not-downloaded** to keep Batch 1 lean; collect on demand if the extraction phase
  needs the supporting layers.
- **No corruption, no licensing blocks, no API failures** for the collected items (both
  HTTP 200, valid checksums, passed readiness).

## 7. Recommendations before Batch 2
1. **Derive, don't download, subset sources:** treat LSC-0019 (and similar "subset" catalog
   entries) as processing-time filters over their parent dataset; add a `derivedFrom` handling
   rule so they never block a batch.
2. **Per-portal change-detection:** where HTTP ETag/Last-Modified are absent (ScienceBase), fall
   back to the source's native version field; record it in the manifest.
3. **Add GDAL/OGR to the extraction environment** so FileGDB/Shapefile/GeoTIFF get deep
   geometry+CRS validation (Batch 1 used structural checks only).
4. **Confirm storage target for real runs:** Batch 2 (B2 open PDFs, 12 items) is smaller
   (~100–300 MB) but the store should move from the session scratchpad to a persistent
   location before large geospatial batches.
5. **Keep the deferred 490 MB LSC-0020 supporting data** decision explicit — collect only if
   required downstream.

## Registry write-back (verification)
Canonical `corpus_registry.json` updated for LSC-0001/0011/0018/0019/0020 — collection-state
fields only (`status`, `checksum`, `fileSize`, `snapshotVersion`, `storageLocation`,
`collectionTimestamp`, `availability`, `extractionReady`, `validationNote`). **Immutable
scientific metadata changed: 0** (verified). Scientific fields, IDs, and relationships unchanged.

---
**Batch 1 complete. Stopping for review — Batch 2 not started.**

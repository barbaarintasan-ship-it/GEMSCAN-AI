# Physical Collection — Execution Plan (P2 · Phase 3)

**Status:** PLAN ONLY — no downloads, no extraction, no DB, no embeddings. Execution
begins only on explicit approval (downloads are permission-gated).
**Input:** frozen `corpus_registry.json` v1.2 (70 active records; 2 logical duplicates
excluded from collection). The registry is the sole work-list; collection writes back
**only collection-state fields** (`status`, `checksum`, `fileSize`, `snapshotVersion`,
`storageLocation`, `collectionTimestamp`, `availability`). Scientific metadata is immutable.

## 1. Batch structure (derived from the registry)

| Batch | What | Records | Method |
|---|---|---:|---|
| **B1 — Spatial backbone** | UNESCO map, FAO SWALIM, USGS MRDS + MRDS-Africa + Africa-GIS | **5** | GIS/dataset export + structured import |
| **B2 — Open PDF reports** | Greenwood, IAEA (IUREP/TECDOC/UDEPO), World Bank, USGS yearbook, ESCWA, Mohr, OneGeology, BRGM-Africa map, Smithsonian mineral search, IJISRT review | **12** | direct HTTPS file fetch + a few dataset/portal exports |
| **B3 — Historical / multilingual (direct URL)** | UN/UNDP survey, Farquharson 1924, colonial surveys, LoC 1944, Bollettino SGI, BSGI, BRGM SIGAfrique, mindat | **8** | direct fetch + OCR-flagged + structured import |
| **B4 — Portal / DB harvest** | BGS OpenGeoscience, IAEA INIS, BRGM InfoTerre, EThOS, NDLTD, UJ theses, Smithsonian meteorite, Africa Groundwater Atlas | **8** | query/API harvest (record subsets, not single files) |
| **Track T-INST — institutional request** | GEOSOM/Somali Survey series, UNRFNRE (Chakrabarti), Rosgeolfond/VSEGEI, GEOSOM-87 proceedings, Merla/Abbate map, Kononov, ISPRA/CNR, BGR/NGAC, OAGS/PanAfGeo/AMGI/GIRAF, ProQuest, historical journals w/o open URL | **22** | **NOT auto-downloaded** — outreach/manual; enters registry when obtained |
| **Track T-PERM — license clearance** | paywalled/unknown-licence journals & maps (Barkasan, Ali&Watts, Lenoir, granitoids, Conti, Geologia stratigrafica, CUGB jade, German Springer, Arabic reports, SomaliTalk review, 1:125k maps) | **15** | **BLOCKED until licence cleared**; then routed to a batch |

Automated download scope = **B1–B4 = 33 records**. T-INST (22) and T-PERM (15) are
prerequisite tracks handled outside the download pipeline.

## 2. Per-batch detail

### B1 — Spatial backbone (5) — run FIRST
- Contents: LSC-0001, 0011, 0018, 0019, 0020.
- Storage estimate: **~0.3–1.5 GB** (GeoTIFF/shapefile rasters dominate; MRDS full export ≈ tens of MB; UNESCO GeoJSON small).
- Duration estimate: **~1–3 h** (large raster/dataset transfers + verification).
- Success criteria: all 5 fetched, checksums recorded, each opens/parses (valid GeoJSON/shapefile/CSV), MRDS Somalia subset row-count > 0.

### B2 — Open PDF reports (12)
- Contents: LSC-0002, 0004, 0005, 0006, 0013, 0014, 0015, 0017, 0021, 0022, 0064, 0072.
- Storage estimate: **~100–300 MB** (born-digital PDFs avg ~5–15 MB; BRGM/OneGeology map exports larger).
- Duration estimate: **~1–2 h**.
- Success criteria: every PDF downloads with HTTP 200, non-zero bytes, valid PDF header, page-count > 0; portal exports return ≥1 record.

### B3 — Historical / multilingual, direct URL (8)
- Contents: LSC-0003, 0007, 0008, 0010, 0041, 0042, 0049, 0051.
- Storage estimate: **~200–600 MB** (scanned books/journals are large; SIGAfrique DB moderate).
- Duration estimate: **~2–4 h** (large scans; Internet Archive/BHL throttling).
- Success criteria: files fetched + checksummed; scanned items flagged `ocr-pending`; mindat/SIGAfrique structured exports parse.

### B4 — Portal / DB harvest (8)
- Contents: LSC-0012, 0023, 0024, 0048, 0061, 0062, 0063, 0066.
- Storage estimate: **~50–200 MB** (query-result subsets + matched PDFs).
- Duration estimate: **~2–4 h** (rate-limited queries; iterate result pages).
- Success criteria: each portal returns a saved result set (JSON/CSV) with the query, hit-count, and retrieval timestamp; matched open-access items downloaded.

**Working total (B1–B4): ~0.65–2.6 GB, ~6–13 h wall-clock** with retries/politeness delays.
Provision **≥10 GB** headroom (raw + snapshots + versions + working copies).

## 3. Cross-cutting workflows

### Checksum workflow
- On each successful download: compute **SHA-256** (+ byte size), write to registry
  `checksum` + `fileSize`; store alongside a per-file sidecar `<id>.meta.json`
  (url, http status, etag/last-modified, timestamp, sha256).
- A download is "verified" only after checksum is computed and the file passes a
  type sanity check (PDF header / valid zip-shapefile / parseable JSON-CSV).

### Byte-level dedup workflow
- Maintain a global `sha256 → LSC-id` index. Before storing, if the sha256 already
  exists, do **not** re-store; mark the new record `availability: duplicate-content`
  with `relations += {duplicate-of: <first-id>}` (logical duplicates like LSC-0028/
  0065 are already flagged and skipped). Different URLs → same bytes are collapsed.

### Snapshot / version strategy
- Content-addressed store: `raw/<sha256[:2]>/<sha256>.<ext>`; human path via symlink
  `by-id/<LSC-id>/vN/`.
- Each dataset/portal source is versioned `vN` keyed to its `dataset_registry` version
  (or a capture date for portals). Re-collection that yields new bytes creates `vN+1`;
  the prior version is retained (never overwritten). `snapshotVersion` recorded per record.
- A batch-level manifest snapshot (`snapshots/<batch>-<UTC>.json`) freezes exactly what
  was collected + checksums for that run.

### Retry strategy
- Per file: up to **5 attempts**, exponential backoff (2s→4s→8s→16s→32s) + jitter;
  honor `Retry-After`; per-host concurrency cap (≤2) and a politeness delay.
- Distinguish **transient** (timeout, 429, 5xx → retry) from **permanent** (404, 403,
  410 → mark failed, no retry). Resume partial transfers with HTTP Range when supported.

### Failure recovery
- Every item ends in a terminal state: `collected` · `failed-permanent` · `blocked-permission`
  · `needs-institutional-request`. Failures logged to `collection_log.jsonl`
  (id, url, attempts, http, error, timestamp). A batch never aborts on a single
  failure — it isolates and continues (like the GeoContext engine's provider isolation).

### Resume capability
- Idempotent + resumable: on restart, skip any record already `collected` with a valid
  checksum; retry only `failed`/`pending`. The registry + `collection_log.jsonl` +
  content-addressed store together are the durable state — safe to stop/resume any time.

### Progress reporting
- After each batch: a report with `attempted / collected / failed / blocked`, bytes
  downloaded, dedup hits, and the per-item terminal states; plus a running
  `collection_status.json` (counts by batch + overall %). Human-readable summary posted
  at each batch boundary for review.

## 4. Storage layout
```
corpus/
  raw/<sha256>.<ext>                 # content-addressed, immutable
  by-id/<LSC-id>/vN/ -> raw/...      # human navigation (symlink)
  meta/<LSC-id>.meta.json            # per-file provenance + checksum
  snapshots/<batch>-<UTC>.json       # per-run frozen manifest
  logs/collection_log.jsonl          # append-only event log
  collection_status.json             # live progress
```

## 5. Registry write-back (collection-state ONLY)
Permitted fields: `status` (queued→downloading→collected/failed/blocked), `checksum`,
`fileSize`, `snapshotVersion`, `storageLocation`, `collectionTimestamp`, `availability`.
**No scientific-metadata edits.** New documents discovered mid-collection are **added to
the registry first** (new LSC-id) before any download.

## 6. Overall success criteria & go/no-go gates
- **Batch success:** ≥95% of the batch's records reach `collected` with valid checksums,
  OR every non-collected item has a recorded terminal reason (permanent/blocked). Manifest
  snapshot written. Human review at the boundary before the next batch starts.
- **Milestone success:** B1–B4 complete; all open-licence P1/P2 items collected + verified;
  T-PERM items either cleared+collected or explicitly deferred; T-INST outreach list issued.
- **Go/no-go per batch:** proceed only if storage headroom ≥ 2× the batch estimate and the
  prior batch's report was reviewed.

## 7. Prerequisite tracks (before/parallel, not downloads)
- **T-PERM (15):** clear licences first; only then route each into B2/B3. Nothing paywalled
  is fetched without a cleared licence.
- **T-INST (22):** outreach to GEOSOM, UNRFNRE, Rosgeolfond/VSEGEI, Ist. Agronomico per
  l'Oltremare (Firenze), ISPRA/CNR, BGR, NGAC, OAGS. These enter a batch only once a file
  is legitimately obtained.

---
**Deliverable = this plan. Execution is not started.** Awaiting approval to begin B1.

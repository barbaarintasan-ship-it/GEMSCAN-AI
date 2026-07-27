# Pilot Collection — Review

**Status:** Pilot executed (4 representative sources actually downloaded) — awaiting
approval for Batch 1. Downloads live in the session scratchpad
(`corpus_pilot/`); **no binaries committed to the repo; canonical frozen registry
untouched** (write-back demonstrated on a pilot copy). No extraction / DB / embeddings.

## 1. What was collected (one per category)
| Category | Record | Source | Result | Size | SHA-256 (head) | Type-valid |
|---|---|---|---|---:|---|:--:|
| GIS dataset | LSC-0001 | UNESCO IHP-WINS Somalia geology map → **GPKG** | collected | 36.2 MB | `42e29086…` | ✅ (SQLite) |
| Born-digital PDF | LSC-0002 | USGS Greenwood OFR 82-788 | collected | 641 KB | `beaafe46…` | ✅ (%PDF) |
| Scanned historical | LSC-0007 | Farquharson 1924 (Internet Archive, LowRes) | collected | 11.9 MB | `891f8a4b…` | ✅ (%PDF) |
| Portal / API export | LSC-0011 | FAO SWALIM GeoNode API (search=geology) | collected | 580 KB | `a2084f9e…` | ✅ (JSON) |
| _dedup probe_ | LSC-0002-DUP | same bytes as LSC-0002 | **DEDUP → LSC-0002** | — | `beaafe46…` | — |

## 2. Workflow validation
| Workflow | Result |
|---|---|
| **Download** (incl. retry/backoff) | ✅ 4/4 via `curl -sL`, 5-attempt exponential backoff, transient-vs-permanent split |
| **Checksum** (SHA-256 + size + sidecar) | ✅ all files hashed; `meta/<id>.meta.json` written |
| **Byte-level dedup** (global sha256 index) | ✅ LSC-0002-DUP detected as identical bytes → not re-stored, marked `duplicate-content` + `duplicateOf` |
| **Snapshot creation** | ✅ `snapshots/pilot-20260727T051808.json` (per-run frozen manifest) |
| **Storage layout** (content-addressed) | ✅ `raw/<sha256>.<ext>` + `meta/` + `by-id/` + `snapshots/` + `logs/` |
| **Registry write-back** (collection-state only) | ✅ on pilot copy `registry_pilot_state.json`; **0 changes to immutable scientific metadata**; canonical untouched |
| **Resume capability** | ✅ 2nd run skipped all `collected` records (idempotent via status + checksum) |
| **Progress reporting** | ✅ `collection_status.json` + append-only `collection_log.jsonl` + per-run report |

## 3. What failed / real-world findings
1. **Portal APIs are not uniform.** UNESCO IHP-WINS rejected CKAN `GET` ("use POST"); resolved by switching to **CKAN `package_show` POST**, which returned 7 resources (SHP/GPKG/PDF/TIF/SLD). Registry URLs for portal/GIS items are **landing pages, not file URLs** — each needs a resolver step.
2. **Portal search returns noise.** SWALIM `search=geology` surfaced mostly agriculture/irrigation datasets in the top hits — raw queries need **curated query strings + relevance filtering** to isolate geology.
3. **Windows symlinks unavailable** (no privilege) → used **pointer JSON** (`by-id/<id>.json`) instead. Works; documented.
4. **Format/edition choice matters.** GPKG (36 MB) vs SHP vs TIF (larger) for the same map; Farquharson has LowRes (11.9 MB) vs full-res. The chosen resource/edition must be recorded for reproducibility.
5. **License gate not exercised** — all 4 pilot items are open-licence; the T-PERM clearance gate still needs a live test before any paywalled/unknown download.

## 4. Required improvements before full-scale
- **Add per-portal resolver adapters:** CKAN-POST (IHP-WINS), GeoNode API (SWALIM), Internet Archive metadata API (archive.org). Persist the **resolved file URL + chosen format/edition** into `meta`.
- **Curate B4 portal queries** (per-source query strings) + relevance filter; save the query + hit-count with each export.
- **Record `resourceFormat` / `edition`** per collected file (GPKG vs SHP; LowRes vs full).
- **Wire the license gate** ahead of download for T-PERM items (block unless `licenseStatus=confirmed`/open).
- Confirm per-host politeness delay + concurrency cap in the batch runner (pilot used sequential; formalize for scale).

## 5. Assessment & recommendation
- **B1–B3 (direct-file downloads: GIS/PDF/scanned)** are **fully validated** — download, checksum, dedup, snapshot, storage, write-back, resume, and reporting all worked end-to-end.
- **B4 (portal/API harvest)** works mechanically but needs the **portal-resolver adapters + query curation** above before running at scale.
- **Recommendation: APPROVE the workflow for full-scale collection**, with B4 gated on the portal-adapter/query improvements (which do not affect B1–B3). Suggested start: **Batch 1 (spatial backbone)** — its 5 items are direct GIS/dataset fetches of the exact type proven here (UNESCO GPKG already collected as LSC-0001).

---
**Awaiting approval.** On approval, Batch 1 begins (with the canonical registry receiving
collection-state write-backs, and B4 improvements implemented before the portal batch).

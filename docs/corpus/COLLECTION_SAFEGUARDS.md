# Collection Safeguards (pre-Batch-1) — implemented & validated

Two safeguards added to the Physical Collection workflow and validated on the pilot
artifacts (positive: 4 real files; negative: 3 deliberately-corrupt files). No repo
binaries; canonical registry untouched.

## Safeguard 1 — per-batch `resource_manifest.json`
Written per batch, capturing for every collected resource:
`id · resolvedUrl · resourceId · format · version · etag · lastModified · captureTimestamp · sha256 · bytes`.
Enables reproducibility + audit (re-fetch the exact resource; detect upstream changes via ETag/Last-Modified).

Pilot manifest (validated):
| id | format | ETag | Last-Modified |
|---|---|---|---|
| LSC-0001 | GPKG | `"0x8DDEB7AA9210E60"` | Thu, 04 Sep 2025 06:17:01 GMT |
| LSC-0002 | PDF | `a0351-49773b0e9fb00` | Wed, 15 Dec 2010 14:24:12 GMT |
| LSC-0007 | PDF | `5fe3c960-b588fa` | Wed, 23 Dec 2020 22:49:04 GMT |
| LSC-0011 | JSON | — | — (portal API supplies neither; recorded honestly) |

## Safeguard 2 — Extraction-Readiness validation
After download, each artifact runs a **format-specific structural check** before it is
eligible for extraction. **Downloaded ≠ Extraction Ready.**

| Format | Check | Tool |
|---|---|---|
| PDF | parses; page-1 text probe (flags image-only → OCR needed, still ready) | `pdftotext` |
| GeoPackage | `gpkg_contents` opens and lists ≥1 layer | `sqlite3` |
| Shapefile (.shp/.zip) | components (.shp/.shx/.dbf) present + `.shp` magic 9994 | struct/zip |
| GeoTIFF | TIFF header (II*/MM*) valid | struct |
| JSON/GeoJSON | parses; GeoJSON `FeatureCollection` / portal record set recognised | `json` |

Outcome sets state:
- pass → `status: collected`, `extractionReady: true`
- fail → **`status: collected-but-invalid`**, `extractionReady: false`, `validationNote: <reason>` — **excluded from the extraction pipeline** until fixed/re-collected.

**Validation results**
- Positive (real pilot files): LSC-0001 GPKG `1 layer` ✅ · LSC-0002 PDF `text layer` ✅ · LSC-0007 PDF `text layer` ✅ · LSC-0011 JSON `portal export, 25 records` ✅ → all `collected`/extractionReady.
- Negative (corrupt files): `bad.pdf → collected-but-invalid (pdftotext failed)` · `bad.gpkg → collected-but-invalid (not a database)` · `bad.json → collected-but-invalid (invalid json)` ✅ — branch confirmed.

**Limitation (honest):** no GDAL/OGR in this environment → Shapefile/GeoTIFF get
**structural** validation only (component/header). Deep geometry/CRS validation is
deferred to an environment with GDAL (or added as a follow-up validator); such items
are marked `collected` with a `validationNote` recording the limited check.

## Status
Both safeguards implemented and validated. Collection state now distinguishes
`collected` · `collected-but-invalid` · `failed` · `duplicate-content`. **Batch 1 is
approved and ready to begin** with manifest + extraction-readiness applied and
collection-state written back to the canonical registry.

> Note (from Pilot Review): Batch 1's MRDS/USGS-Africa GIS items (LSC-0018/0019/0020)
> are portal landing pages needing resolver adapters (ScienceBase API for LSC-0020;
> MRDS export endpoint for 0018/0019). These resolvers are built at Batch-1 start;
> unresolved items terminate as `needs-institutional-request`/`failed` (never crash).

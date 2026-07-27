# Corpus Governance & Metadata Registry (P2.1)

`corpus_registry.json` is the **authoritative index** for the Knowledge Extraction
Pipeline — one record per discovered source (70 total, from
[GEOCONTEXT_P2_CORPUS_MANIFEST.md](../GEOCONTEXT_P2_CORPUS_MANIFEST.md)). **No files
have been downloaded**; this is pre-collection governance metadata. On approval of the
collection phase it seeds a `geo.corpus_source` table (its own migration).

## Record schema
| Field | Meaning |
|---|---|
| `id` | Persistent ID `LSC-####` (never reassigned) |
| `catalogRef` | Manifest section code (S/I/D/IT/RU/… ) |
| `title` | Document / collection title |
| `authorsOrOrg` | Author(s) or issuing organisation |
| `publisher` | Publisher / archive |
| `year` | Year or range (`—` if unknown) |
| `language` | ISO-ish: en, it, ru, fr, de, zh, ar, multi |
| `country` | Primary country focus |
| `geographicCoverage` | national · n-somaliland · regional · continental · global |
| `commodities` | e.g. Au, U, Cr, Ni, Be, REE, gemstones, `all` |
| `geologicalThemes` | regional-geology, stratigraphy, mineral-occurrences, geochemistry, geophysics, structural, uranium, hydrogeology, gemstones, petrography, coal, mining-sector, ontology-reference |
| `docType` | gis · dataset · pdf-report · map · book · journal · thesis · portal · archive · db |
| `url` | Access URL / archive locator (`—` = offline, request needed) |
| `license` | e.g. us-gov-public-domain, un, iaea, ogl, cc, ©-permission-needed, unknown |
| `extractionRequirements` | gis-direct · structured-import · pdf-text · ocr · translate:xx · portal-query · institutional-request |
| `collectionPriority` | P1 (backbone/top) · P2 (authoritative PDF) · P3 (historical/secondary/portal-later) |
| `qualityTier` | T1 (structured, ingestible) · T2 (authoritative PDF) · T3 (historical, OCR) · Tref (portal/reference) |
| `status` | `cataloged` (pre-collection) → later: queued · collected · verified |
| `checksum` | `null` until the (permission-gated) download step |

## Governance rules
- **IDs are permanent.** Superseded/duplicate items are marked, never re-numbered.
- **Checksums, byte-level dedup, and file quality scores are populated only at
  collection time** (requires download permission) — they are `null` here.
- Licences marked `unknown`/`©-permission-needed` must be cleared **before** any
  download or extraction.
- `institutional-request` items (GEOSOM, UNRFNRE, Rosgeolfond, proprietary company)
  are not web-collectable and need direct outreach.

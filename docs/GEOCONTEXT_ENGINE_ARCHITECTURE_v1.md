# Luul Scan — GeoContext Engine Architecture v1.0

**Status:** Design (pre-implementation). Extends the frozen Phase-1 enterprise
foundation (migrations 0018–0043, tag `v1.0-security-complete`).

## 1. Purpose

The GeoContext Engine is the **evidence-based geological intelligence layer**
between AI mineral identification and the AI geological reasoning engine. It
never relies on image recognition alone. It fuses AI vision, GPS, geological
datasets, historical exploration knowledge, mineral databases, and community
intelligence into **one structured JSON object** — the single source of
geological truth passed downstream.

```
Camera → AI Mineral Identification → GPS → GeoContext Engine → AI Geological Reasoning → Report
```

### Non-negotiable principles
1. **GeoContext never asserts presence.** It never says "there is gold here." It
   states favorability + evidence + confidence.
2. **GeoContext never calls an LLM at runtime.** Its job ends at producing JSON.
   AI reasoning is a separate service. (Offline knowledge extraction MAY use an
   LLM — a different boundary, see §5.)
3. **No PDF/document parsing at runtime.** Reports are transformed into a
   normalized knowledge database *offline*; runtime only queries structured data.
4. **Modular & extensible.** New data sources plug in as adapters without
   architectural change.
5. **Reuse the existing foundation.** Read the `geo`/`enterprise` schema built in
   Sprint 2/3; add new tables only for genuinely new data.

## 2. Topology decision

**Chosen: Supabase Edge Function (`geocontext`, Deno) + PostGIS.** No Redis, no
separate microservice, no vector-tile server in v1.

- PostGIS 3.3.7 is already provisioned; the `geo` schema, GIST indexes, and the
  4.1.a auth middleware already exist. A separate microservice + Redis would add
  new infrastructure and a second auth model for no v1 benefit.
- **Caching** uses Postgres: materialized views for heavy joins and a
  `geo.geocontext_cache` table keyed by H3 cell + version (H3 is already stored as
  text; `geo.coverage_cell` already uses it). Redis can be added later behind the
  same cache interface if needed — no architectural change.
- **Parallelism** is `Promise.all` across providers inside the Edge Function.

This is the runtime consequence of principle 3: runtime only queries structured
data, so we do not need a heavy service — a stateless Edge Function over PostGIS
is sufficient.

## 3. Two provider categories

GeoContext must **not** assume every provider is a GIS layer. There are two
distinct kinds:

### Category A — Spatial Providers
Answer *"what exists at / near this GPS location?"* via PostGIS.
- `GeologyProvider` → `geo.geological_layer` (UNESCO polygons) — `ST_Contains`/`ST_DWithin`
- `OccurrenceProvider` → `geo.mineral_occurrence` (MRDS + extracted occurrences) — radius query
- `CommunityProvider` → `enterprise.sample` + verification + `geo.coverage_cell`
- *(future)* `RemoteSensingProvider`, `GeophysicsProvider`, `GeochemProvider`, `StructuralProvider`, `HydrologyProvider`

### Category B — Geological Knowledge Providers
Serve knowledge **already extracted** from historical reports (never parse at
runtime). Query the normalized knowledge DB, optionally spatially filtered.
- `KnowledgeProvider` → `geo.geological_knowledge` (from Greenwood, GEOSOM, UNDP, IAEA, Soviet/Italian/company reports)
- `MineralAssociationProvider` → `geo.mineral_association` (queryable KB: quartz→gold, pegmatite→beryl/tourmaline/spodumene, ultramafic→chromite/nickel, carbonatite→REE, evaporites→gypsum/salt)

Both categories implement the same interface (§6) so the engine treats them
uniformly.

## 4. Confirmed Phase-1 datasets

| Dataset | Category | Form | Target store |
|---|---|---|---|
| **UNESCO Geological Map of Somalia** | A (spatial) | GeoJSON polygons (lithology, formation, age, structural units) | `geo.geological_layer` |
| **USGS MRDS** | A (spatial) | occurrences (commodity, deposit type, host rocks, refs, coords) | `geo.mineral_occurrence` |
| **Greenwood reports** | B (knowledge) | documents | `geo.geological_knowledge` |
| **GEOSOM** | B (knowledge) | documents | `geo.geological_knowledge` |
| **UNDP mineral surveys** | B (knowledge) | documents (stream sediment, geochem, groundwater, lab) | `geo.geological_knowledge` |
| **IAEA reports** | B (knowledge) | documents (structural, non-radioactive occurrences, U exploration) | `geo.geological_knowledge` |

## 5. Geological Knowledge Extraction Pipeline (first-class, OFFLINE)

A subsystem that transforms historical geological reports into structured
knowledge **before** runtime. This is where a large part of Luul Scan's
scientific value comes from — turning documents into evidence that can
participate in reasoning.

```
Historical reports (Greenwood / GEOSOM / UNDP / IAEA / Soviet / Italian / company)
        ↓  IMPORT        register source + metadata (geo.knowledge_source)
        ↓  PARSE         PDF text / OCR for scanned pages
        ↓  EXTRACT       LLM-assisted + rule-based entity extraction:
                           occurrences · host rocks · formations · structures ·
                           exploration targets · commodities · coordinates ·
                           commodity associations
        ↓  NORMALIZE      map to controlled vocab (taxonomy / deposit_model /
                           evidence_tier lookups from migration 0019)
        ↓  REVIEW         human QA gate (accept/reject/edit) — provenance kept
        ↓  LOAD           geo.geological_knowledge (+ geo.mineral_occurrence for
                           point occurrences), every row citing its source +
                           page + quote
```

Rules:
- **Runs offline** (batch ingestion job / CLI), **never in the request path**.
- **Provenance preserved** on every extracted fact: `knowledge_source` reference,
  page, and verbatim quote — so downstream reasoning is auditable.
- **LLM use is allowed here** (extraction is ingestion, not runtime reasoning) but
  outputs pass a human QA gate before load.
- Extraction confidence is stored per fact (mapped to `evidence_tier`), so the
  runtime confidence model can weight report-derived evidence appropriately.
- Adding a new report type (Soviet, company, future publication) = a new
  extraction profile, **no runtime change**.

## 6. Provider interface (uniform for A and B)

```ts
interface GeoQuery {
  lat: number; lng: number; radiusM: number;
  h3?: string;            // precomputed cell for cache keying
  mineralHint?: string;   // from AI identification, optional
}

interface ProviderContribution {
  provider: string;                 // "geology" | "occurrence" | "knowledge" | ...
  category: "spatial" | "knowledge";
  data: Record<string, unknown>;    // provider-shaped partial context
  evidence: EvidenceItem[];         // normalized evidence statements
  confidence: number;               // 0..1 provider-local confidence
  provenance: Provenance[];         // source + reference (+ page/quote for B)
}

interface GeoContextProvider {
  readonly name: string;
  readonly category: "spatial" | "knowledge";
  fetch(q: GeoQuery): Promise<ProviderContribution>;   // must be side-effect free + cacheable
}
```

Providers are loosely coupled, independently testable, and register with the
engine; a failing/slow provider degrades gracefully (its contribution is omitted,
overall confidence lowered) rather than failing the whole request.

## 7. Runtime architecture

```
GeoContextEngine.run(query)
  ├─ resolve H3 cell → check geo.geocontext_cache (hit → return)
  ├─ Promise.all([...spatialProviders, ...knowledgeProviders])  (parallel, timeout-guarded)
  ├─ Evidence Fusion       merge contributions; resolve corroboration/conflict
  ├─ Confidence Weighting  per-signal + overall (see §9)
  ├─ assemble GeoContext JSON (§8)
  └─ write-through cache (H3 + version + TTL)
```

## 8. GeoContext JSON contract (engine output)

```jsonc
{
  "location":   { "lat": 0, "lng": 0, "h3": "…", "adminRegion": "…" },
  "geology":    { "unit": "…", "tectonicProvince": "…", "structuralSetting": "…" },
  "formations": [ { "name": "…", "age": "…", "source": "UNESCO" } ],
  "lithology":  [ { "rockType": "…", "rockClass": "…" } ],
  "hostRocks":  [ "…" ],
  "faults":     [ { "name": "…", "distanceM": 0, "type": "…" } ],
  "intrusions": [ { "type": "…", "distanceM": 0 } ],
  "metamorphism": { "belt": "…", "grade": "…" },
  "knownOccurrences": [ { "commodity": "Au", "depositType": "…", "distanceM": 0, "source": "MRDS", "reference": "…" } ],
  "commodityAssociations": [ { "setting": "quartz vein", "commodities": ["Au"], "weight": 0.0 } ],
  "geochemistry": { "anomalies": [ { "element": "Au", "medium": "stream sediment", "source": "UNDP", "reference": "…" } ] },
  "geophysics":   { "anomalies": [] },
  "remoteSensing":{ "alteration": [] },
  "historicalReports": [ { "source": "Greenwood 1982", "observation": "…", "reference": "…", "page": 0 } ],
  "communityEvidence": { "verifiedScans": 0, "expertConfirmations": 0, "labConfirmations": 0, "clusterDensity": 0.0 },
  "confidence": { "overall": "Moderate", "score": 0.0, "byProvider": {}, "factors": ["…"] }
}
```

## 9. Intelligence & confidence rules

GeoContext emits **evidence statements**, never claims of presence. Example
output narrative (as structured `evidence[]` + `factors[]`):
- "Geological setting is favorable for orogenic gold."
- "Quartz veins nearby increase probability."
- "Historical exploration reported gold anomalies (Greenwood 1982, p.X)."
- "Stream sediment samples contained elevated Au (UNDP survey)."
- "Community observations indicate repeated quartz discoveries."
- "Overall geological confidence: **Moderate**."

Confidence weighting factors:
- **Source reliability tier** — `evidence_tier` lookup (community < historical report < mapped GIS < verified/lab).
- **Spatial proximity** — closer occurrences/anomalies weigh more.
- **Corroboration** — multiple independent providers agreeing raises confidence.
- **Community** — *only strengthens* existing evidence; **never used alone**.

## 10. AI independence boundary

- **Runtime:** GeoContext → JSON only. It never calls GPT/Claude/Gemini. The AI
  Geological Reasoning Engine consumes the JSON separately.
- **Offline:** the Knowledge Extraction Pipeline may call an LLM for extraction,
  gated by human QA. These two boundaries never mix.

## 11. Data model — reuse + new tables

**Reused (Sprint 2/3):** `geo.geological_layer` (UNESCO polygons), `enterprise.sample`
+ verification + `geo.coverage_cell` (community), `enterprise.occurrence_evidence`/
`lab_result` (user-workflow occurrences), lookups `taxonomy`/`deposit_model`/
`evidence_tier` (0019).

**New — post-freeze migrations `0044+` (geo schema, same migration discipline as
Sprint 3: one migration → shadow test → VERIFY → RLS → review → commit):**
- `geo.mineral_occurrence` — external reference occurrences (MRDS + extracted): commodity, deposit_type, host_rocks[], geom(Point), source, reference, tier.
- `geo.knowledge_source` — report metadata: title, author, year, org, source_type, uri/checksum.
- `geo.geological_knowledge` — normalized extracted facts: source_id FK, kind, geom(nullable), attributes jsonb, quote, page, tier.
- `geo.mineral_association` — commodity association KB (setting/host → commodities[], weight).
- `geo.geocontext_cache` — H3 cell → cached GeoContext JSON + version + expires_at.

> **Note — post-freeze extension:** the v1.0 freeze covered the Phase-1 enterprise
> core. GeoContext is a new subsystem; its tables are added via new migrations
> under the same discipline, RLS default-deny + read policies (reference data
> readable by authenticated; writes service-only, like migration 0040/0042).

## 12. Performance
PostGIS GIST spatial indexing (exists on geo geoms); materialized views for heavy
joins; `geo.geocontext_cache` (H3-keyed) for repeat lookups; async + parallel
provider execution with per-provider timeouts; background dataset indexing during
ingestion. No Redis/vector-tiles in v1 (addable later behind the cache interface).

## 13. Extensibility
New Category-A adapters (airborne geophysics, hyperspectral/ASTER/Landsat/Sentinel
alteration, LiDAR, drone mapping, borehole/drill-core, ML prospectivity) and new
Category-B extraction profiles (Soviet, company reports, future publications) plug
in by implementing the provider interface / adding an extraction profile — **no
change to the engine, contract, or runtime**.

## 14. Phased implementation (review-gated)

- **P0 — Schema:** migrations `0044+` for the new tables above (shadow-tested,
  RLS, committed one at a time).
- **P1 — Runtime framework + data-backed providers:** engine + provider interface
  + cache; `GeologyProvider` (UNESCO/PostGIS), `OccurrenceProvider` (MRDS),
  `CommunityProvider`, `MineralAssociationProvider` → emits GeoContext JSON. Depends
  on the 4.1 auth middleware.
- **P2 — Knowledge Extraction Pipeline (offline) + KnowledgeProvider:** ingest
  Greenwood/GEOSOM/UNDP/IAEA → `geo.geological_knowledge` → wire `KnowledgeProvider`.
- **P3+ — Future adapters** (geophysics/geochem/remote sensing/structural/hydrology)
  as datasets arrive.

## 15. Open decisions / dependencies
1. **Sequencing:** GeoContext P1 depends on the 4.1 backend foundation (4.1.a done,
   4.1.b pending). Finish 4.1 first, then GeoContext P0 → P1.
2. **Ingestion location** for UNESCO GeoJSON + MRDS: a seed migration vs a one-off
   loader script (recommend a loader script + `geo.raster_layer_registry`/source
   tracking, so large datasets don't bloat migrations).
3. **Knowledge extraction LLM + QA tooling** (P2) — chosen offline model + the
   human-review surface — to be specified when P2 begins.

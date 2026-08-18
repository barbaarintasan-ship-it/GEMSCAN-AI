# LuulScan GIS Ingestion — Structural Geology Layers

**The system is READY for real geological data. It ships NO synthetic structure.**
Every structural layer is `NO SOURCE AVAILABLE` until an official dataset is
imported. Fabricating faults or lineaments (from a DEM's raw output, polygon
adjacency, or anything else) and presenting them as mapped structure is
forbidden — Architecture Invariant 4.

This document is the contract: what files are required, the exact format they
must be in, how to import them, and what is currently missing.

---

## 1. Pipeline (where data flows)

```
official GIS (shapefile / GeoJSON)
        │  ogr2ogr → GeoJSON (EPSG:4326)
        ▼
scripts/import-structural-gis.ts  ──►  geo.structural_feature   (PostGIS geography 4326)
        │                                     │
        │                                     ├─►  geo.gis_layer_status   (loaded / no_source_available)
        │                                     └─►  geo.dataset_registry   (provenance)
        ▼
scripts/build-geo-pack.ts  ──►  pack `mapFeatures` (lines)  ──►  bundled into APK
        ▼
lib/geo/targeting.ts prospectivityEvidence()  ──►  distance-to-fault, intersections, structural permeability
```

The engine already contains the structural scoring (`prospectivityEvidence`:
fault proximity, fault×contact intersection). It has simply had **no data to
feed it**. Loading real structure switches it on with no engine change.

---

## 2. Required GIS files

| # | Layer | `--layer` | Geometry | feature_type | Status |
|---|---|---|---|---|---|
| 1 | Regional **faults** | `faults` | LineString / MultiLineString | `fault` | **NO SOURCE AVAILABLE** |
| 2 | Regional **lineaments** | `lineaments` | LineString / MultiLineString | `lineament` | **NO SOURCE AVAILABLE** |
| 3 | **Shear zones** | `shear_zones` | LineString / MultiLineString | `shear_zone` | **NO SOURCE AVAILABLE** |
| 4 | Geological **contacts** | `contacts` | LineString / MultiLineString | `contact` | **NO SOURCE AVAILABLE** |
| 5 | Major **structural trends** / fold axes | `major_trends` | LineString / MultiLineString | `fold_axis` | **NO SOURCE AVAILABLE** |
| 6 | Mineral **occurrences** | (points, separate) | Point | — | LOADED (159, USGS MRDS; sparse in NW) |

The live status is always readable from the database — never assumed:

```sql
select layer_key, status, feature_count, candidate_sources from geo.gis_layer_status order by layer_key;
```

---

## 3. Format specification (canonical GeoJSON)

A `FeatureCollection` of **line** features in **EPSG:4326** (WGS84 lon/lat):

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": { "type": "LineString", "coordinates": [[43.20, 9.94], [43.35, 10.02]] },
      "properties": {
        "name": "Borama Fault",            // optional; also accepts NAME
        "feature_type": "fault",           // optional per-feature override of --layer
        "trend_deg": 145,                  // optional; also accepts `strike`
        "confidence": "medium"             // optional; set via --confidence otherwise
      }
    }
  ]
}
```

- **Geometry MUST be a line.** Points/polygons are skipped (structural features are
  lines; occurrences are a separate point layer).
- **CRS MUST be EPSG:4326.** Reproject on conversion: `-t_srs EPSG:4326`.
- Unknown properties are ignored. Missing `name`/`trend_deg` are fine.

### Shapefile → GeoJSON (lossless)
```bash
ogr2ogr -f GeoJSON -t_srs EPSG:4326 somalia_faults.geojson SomaliaFaults.shp
```

---

## 4. Importing

Dry-run first (validates, writes nothing):
```bash
deno run --allow-env --allow-net --allow-read scripts/import-structural-gis.ts \
  --file data/somalia_faults.geojson --layer faults \
  --source usgs_geo7_2ag --version 1997.OFR97-470A --confidence medium
```

Commit:
```bash
… --apply
```

On `--apply` the tool: registers the dataset (`dataset_registry`), inserts the
lines (`structural_feature`, real geometry only), and flips the layer to
`loaded` in `gis_layer_status`. Then rebuild the pack (`build-geo-pack.ts`).

---

## 5. Real, legally-usable candidate sources (identified in audit)

**None of these are bundled.** They are pointers the operator can obtain and import.

| Layer | Source | Licence | Scale | Note |
|---|---|---|---|---|
| faults, contacts | **USGS geo7_2ag** — Global GIS Digital Atlas of Africa (OFR 97-470A) | Public domain | ~1:5M | Real vector faults + contacts, continental |
| geology, contacts | **BGS Africa Groundwater Atlas — Hydrogeology of Somalia** | CC-BY-SA 3.0 | 1:5M | `bgs.ac.uk/africagroundwateratlas/downloadGIS.html` |
| faults, fracture lineaments | **FAO-SWALIM Somaliland/Puntland** (2012) | UN-FAO / attribution | 1:750k (reg.), 1:250k (sel.) | Best regional detail for NW Somalia |
| occurrences | **USGS Africa Mineral Industries geodatabase** | Public / open | — | Supplements sparse MRDS in NW |

**Honest limits:** the continental sources (USGS/BGS) carry only **major regional**
structure. District-scale (≈1:50k) structural mapping for specific gold areas is
**NO SOURCE AVAILABLE** openly and would require the Somaliland Geological Survey
or a commissioned dataset.

---

## 6. DEM-derived lineaments — policy

Copernicus GLO-30 is open/legal, and automated lineament extraction produces
**real** analytical candidates from **real** elevation data — this is not
fabrication. But it is **interpreted and unverified**, so it is admitted only
under strict labelling:

- `--layer lineaments --source copernicus_dem_derived --confidence interpreted`
  (the importer **refuses** a DEM/Copernicus/SRTM source at any higher confidence).
- Stored with `confidence = 'interpreted'`, carried into the pack, and **never**
  rendered as a mapped fault.

**CONTEXT, NOT SCORED (measured, 18 Aug 2026).** The 5,960 Somalia-nationwide
Copernicus GLO-30 lineaments were validated against the prospectivity baseline and
**leak 4.3x** (present at ~69% of occurrences vs ~16% of background). Because they
are extracted FROM the DEM — which the engine already scores as `terrain` — scoring
their coverage would double-count the landform signal, so `lineaments` is held in
`ROLES_NOT_SCORED` alongside `contacts` (which leak 3.5x for the analogous reason).
They are drawn on the map and reported in the coverage/evidence panel as
`not_scored`, and **do not feed the numeric prospectivity score**. This keeps the
validated ranking (LOO AUC 0.900) intact. See `prospectivityBaseline.test.ts`.

Load authoritative mapped structure (USGS/BGS/SWALIM) first; use DEM-derived only
as a clearly-labelled context layer.

---

## 7. What "NO SOURCE AVAILABLE" means in the app

When a layer is `no_source_available`, the pack carries zero features for it, and
the prospectivity coverage panel reports it as `empty_layer` / `no_source` — the
report says *"regional structural mapping not available"* rather than inventing
alignment it cannot support. This is the honest state, by design, until real data
is loaded.

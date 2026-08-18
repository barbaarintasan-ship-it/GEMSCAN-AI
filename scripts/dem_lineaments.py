#!/usr/bin/env python
"""
DEM-derived lineament extraction from Copernicus GLO-30.

  python scripts/dem_lineaments.py data/dem/*.tif -o data/lineaments/somaliland.geojson

WHAT THIS IS. Automated structural-lineament extraction — the standard remote-
sensing method (multi-azimuth hillshade -> edge detection -> Hough line
transform). Every line produced is traced from REAL Copernicus elevation data;
nothing is invented. But the product is INTERPRETED, not a mapped fault, so each
feature is stamped confidence="interpreted" and source="copernicus_dem_derived"
and must be scored below, and labelled apart from, any authoritative mapped
structure (see docs/GIS_INGESTION.md).

Output: a GeoJSON FeatureCollection of LineStrings in EPSG:4326, ready for
scripts/import-structural-gis.ts --layer lineaments --confidence interpreted.
"""
import sys
import json
import argparse
import math
import numpy as np
import rasterio
from rasterio.transform import xy
from skimage.feature import canny
from skimage.transform import probabilistic_hough_line


def hillshade(dem, azimuth, altitude=45.0):
    """Standard hillshade for one illumination azimuth."""
    dy, dx = np.gradient(dem)
    slope = np.pi / 2.0 - np.arctan(np.hypot(dx, dy))
    aspect = np.arctan2(-dx, dy)
    az = np.radians(360.0 - azimuth + 90.0)
    alt = np.radians(altitude)
    hs = (np.sin(alt) * np.sin(slope)
          + np.cos(alt) * np.cos(slope) * np.cos(az - aspect))
    return np.clip(hs, 0, 1)


def haversine_m(lon1, lat1, lon2, lat2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def bearing_deg(lon1, lat1, lon2, lat2):
    """Structural trend 0..180 (an undirected line)."""
    y = math.sin(math.radians(lon2 - lon1)) * math.cos(math.radians(lat2))
    x = (math.cos(math.radians(lat1)) * math.sin(math.radians(lat2))
         - math.sin(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.cos(math.radians(lon2 - lon1)))
    b = (math.degrees(math.atan2(y, x)) + 360.0) % 180.0
    return round(b, 1)


def extract(path, min_len_m, canny_sigma, hough_threshold, hough_gap):
    with rasterio.open(path) as src:
        dem = src.read(1).astype("float32")
        transform = src.transform
        nod = src.nodata
    if nod is not None:
        dem[dem == nod] = np.nan
    dem = np.nan_to_num(dem, nan=float(np.nanmean(dem)))

    # Lineaments show under one lighting and vanish under another, so edges are
    # accumulated across four illumination azimuths — the discipline that keeps
    # this from just tracing one hillshade's shadows.
    edges = np.zeros(dem.shape, dtype=bool)
    for az in (0, 45, 90, 135):
        edges |= canny(hillshade(dem, az), sigma=canny_sigma)

    # line_length is in pixels; GLO-30 is ~30 m/px, so 40 px ~ 1.2 km minimum.
    px = max(20, int(min_len_m / 30.0))
    segments = probabilistic_hough_line(
        edges, threshold=hough_threshold, line_length=px, line_gap=hough_gap
    )

    feats = []
    for (p0, p1) in segments:
        # hough points are (col, row); rasterio xy(transform, row, col) -> (lon, lat)
        lon0, lat0 = xy(transform, p0[1], p0[0])
        lon1, lat1 = xy(transform, p1[1], p1[0])
        length = haversine_m(lon0, lat0, lon1, lat1)
        if length < min_len_m:
            continue
        feats.append({
            "type": "Feature",
            "geometry": {
                "type": "LineString",
                "coordinates": [[round(lon0, 6), round(lat0, 6)],
                                [round(lon1, 6), round(lat1, 6)]],
            },
            "properties": {
                "feature_type": "lineament",
                "confidence": "interpreted",
                "trend_deg": bearing_deg(lon0, lat0, lon1, lat1),
                "length_m": round(length),
                "source": "copernicus_dem_derived",
                "name": None,
            },
        })
    return feats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tiles", nargs="+", help="Copernicus GLO-30 GeoTIFF tile(s)")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--min-length-m", type=float, default=4000.0)
    ap.add_argument("--canny-sigma", type=float, default=3.5)
    ap.add_argument("--hough-threshold", type=int, default=40)
    ap.add_argument("--hough-gap", type=int, default=3)
    # Keep only the strongest structural signal — the LONGEST lineaments. Automated
    # extraction over-detects drainage/ridge texture; the major, kilometres-long,
    # straight features are the ones with a plausible structural meaning.
    ap.add_argument("--max-per-tile", type=int, default=250)
    a = ap.parse_args()

    all_feats = []
    for t in a.tiles:
        f = extract(t, a.min_length_m, a.canny_sigma, a.hough_threshold, a.hough_gap)
        f.sort(key=lambda x: x["properties"]["length_m"], reverse=True)
        f = f[: a.max_per_tile]
        print(f"  {t}: {len(f)} lineaments (longest {f[0]['properties']['length_m'] if f else 0} m)")
        all_feats.extend(f)

    fc = {"type": "FeatureCollection",
          "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
          "features": all_feats}
    with open(a.out, "w") as fh:
        json.dump(fc, fh)
    print(f"\nWrote {len(all_feats)} DEM-derived lineaments -> {a.out}")


if __name__ == "__main__":
    main()

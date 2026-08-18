#!/usr/bin/env python
"""
Nationwide DEM-derived lineament extraction for Somalia.

Runs the same standard extraction as scripts/dem_lineaments.py (multi-azimuth
hillshade -> Canny -> probabilistic Hough) over EVERY Copernicus GLO-30 tile that
intersects the Somalia ADM0 boundary, then CLIPS the result to Somalia — a segment
is kept only if its midpoint falls inside the national boundary, so border tiles
shared with Ethiopia/Kenya/Djibouti contribute only their Somali-side structure.

Every line is traced from REAL Copernicus elevation data; nothing is invented. The
product is INTERPRETED (confidence="interpreted", source="copernicus_dem_derived")
and must be scored below, and labelled apart from, mapped structure. See
docs/GIS_INGESTION.md.

  python scripts/dem_lineaments_somalia.py \
    --dem-dir data/dem --boundary data/boundary/somalia_adm0.geojson \
    -o data/lineaments/somalia_national.geojson
"""
import sys
import os
import json
import argparse
import glob

# Reuse the audited single-tile extractor unchanged.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dem_lineaments import extract  # noqa: E402

from shapely.geometry import shape, LineString  # noqa: E402
from shapely.ops import unary_union  # noqa: E402


def load_boundary(path):
    d = json.load(open(path, encoding="utf-8"))
    return unary_union([shape(f["geometry"]) for f in d["features"]])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dem-dir", default="data/dem")
    ap.add_argument("--boundary", default="data/boundary/somalia_adm0.geojson")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--min-length-m", type=float, default=2500.0)
    ap.add_argument("--canny-sigma", type=float, default=2.5)
    ap.add_argument("--hough-threshold", type=int, default=18)
    ap.add_argument("--hough-gap", type=int, default=3)
    ap.add_argument("--max-per-tile", type=int, default=150)
    a = ap.parse_args()

    som = load_boundary(a.boundary)
    tiles = sorted(glob.glob(os.path.join(a.dem_dir, "*.tif")))
    print(f"Boundary loaded. {len(tiles)} DEM tile(s) to process.\n")

    national = []
    kept_total = clipped_total = 0
    skipped_tiles = []
    for t in tiles:
        # One unreadable/corrupt tile must not kill a nationwide run — it is skipped,
        # reported, and the remaining tiles still produce a dataset.
        try:
            feats = extract(t, a.min_length_m, a.canny_sigma, a.hough_threshold, a.hough_gap)
        except Exception as e:  # noqa: BLE001
            skipped_tiles.append(os.path.basename(t))
            print(f"  {os.path.basename(t):16s}: SKIPPED (unreadable: {str(e)[:50]})")
            continue
        feats.sort(key=lambda x: x["properties"]["length_m"], reverse=True)
        feats = feats[: a.max_per_tile]
        # Clip to Somalia: keep a segment only if its midpoint is inside the country.
        kept = []
        for f in feats:
            c = f["geometry"]["coordinates"]
            mid = LineString(c).interpolate(0.5, normalized=True)
            if som.contains(mid):
                kept.append(f)
        clipped = len(feats) - len(kept)
        kept_total += len(kept)
        clipped_total += clipped
        print(f"  {os.path.basename(t):16s}: {len(kept):3d} kept  ({clipped} clipped outside SO)")
        national.extend(kept)

    fc = {"type": "FeatureCollection",
          "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
          "features": national}
    with open(a.out, "w") as fh:
        json.dump(fc, fh)
    print(f"\nWrote {kept_total} Somalia lineaments ({clipped_total} clipped) -> {a.out}")
    if skipped_tiles:
        print(f"SKIPPED {len(skipped_tiles)} unreadable tile(s): {', '.join(skipped_tiles)}")
    else:
        print(f"All {len(tiles)} tiles processed cleanly.")


if __name__ == "__main__":
    main()

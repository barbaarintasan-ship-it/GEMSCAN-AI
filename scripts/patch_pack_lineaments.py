#!/usr/bin/env python
"""
Replace the DEM-derived lineament rows in the bundled geo pack with a fresh set
from a national GeoJSON, and keep the manifest count in sync.

  python scripts/patch_pack_lineaments.py \
    --geojson data/lineaments/somalia_national.geojson \
    --pack mobile/assets/geo-pack

Idempotent: it strips every existing kind=="lineament" row first, then appends the
new set, so re-running never double-counts.
"""
import json
import io
import os
import argparse


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--geojson", required=True)
    ap.add_argument("--pack", default="mobile/assets/geo-pack")
    a = ap.parse_args()

    mp_path = os.path.join(a.pack, "maplayers.json")
    man_path = os.path.join(a.pack, "manifest.json")
    mp = json.load(io.open(mp_path, encoding="utf-8"))
    fc = json.load(io.open(a.geojson, encoding="utf-8"))

    before = len(mp["rows"])
    # Drop all existing lineament rows (DEM-derived) — full replace.
    mp["rows"] = [r for r in mp["rows"] if r.get("kind") != "lineament"]
    after_strip = len(mp["rows"])

    added = 0
    for i, f in enumerate(fc["features"]):
        coords = f["geometry"]["coordinates"]
        p = f.get("properties", {})
        xs = [c[0] for c in coords]
        ys = [c[1] for c in coords]
        mp["rows"].append({
            "attributes": {
                "confidence": p.get("confidence", "interpreted"),
                "feature_type": "lineament",
                "trend_deg": p.get("trend_deg"),
            },
            "bbox": [min(xs), min(ys), max(xs), max(ys)],
            "id": f"dem-lineament-{i}",
            "kind": "lineament",
            "lines": [coords],
            "name": None,
            "source": "copernicus_dem_derived",
        })
        added += 1

    total = len(mp["rows"])
    json.dump(mp, io.open(mp_path, "w", encoding="utf-8"))

    man = json.load(io.open(man_path, encoding="utf-8"))
    if isinstance(man.get("counts"), dict) and "mapFeatures" in man["counts"]:
        man["counts"]["mapFeatures"] = total
    json.dump(man, io.open(man_path, "w", encoding="utf-8"))

    print(f"pack rows: {before} -> stripped {before - after_strip} old lineaments "
          f"-> +{added} new -> {total}")
    print(f"manifest counts.mapFeatures -> {man.get('counts', {}).get('mapFeatures')}")


if __name__ == "__main__":
    main()

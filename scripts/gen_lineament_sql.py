#!/usr/bin/env python
"""
Emit chunked SQL to replace geo.structural_feature DEM lineaments with a national set.

  python scripts/gen_lineament_sql.py \
    --geojson data/lineaments/somalia_national.geojson \
    --outdir data/lineaments/sql_chunks --chunk 800

Writes 00_delete.sql (removes old copernicus_dem_derived rows) then chunk_NNN.sql
multi-row INSERTs. Apply in order via the Supabase MCP.
"""
import json
import io
import os
import argparse


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--geojson", required=True)
    ap.add_argument("--outdir", default="data/lineaments/sql_chunks")
    ap.add_argument("--chunk", type=int, default=800)
    a = ap.parse_args()
    os.makedirs(a.outdir, exist_ok=True)

    fc = json.load(io.open(a.geojson, encoding="utf-8"))
    feats = fc["features"]

    with io.open(os.path.join(a.outdir, "00_delete.sql"), "w", encoding="utf-8") as fh:
        fh.write("delete from geo.structural_feature where source_key='copernicus_dem_derived';\n")

    n_chunks = 0
    for start in range(0, len(feats), a.chunk):
        part = feats[start:start + a.chunk]
        vals = []
        for f in part:
            gj = json.dumps(f["geometry"])
            trend = f.get("properties", {}).get("trend_deg")
            trend = "null" if trend is None else str(trend)
            vals.append(
                "('lineament', null, extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('"
                + gj + "'),4326)::extensions.geography, '{}'::jsonb, "
                "'copernicus_dem_derived', 'interpreted', " + trend + ")"
            )
        sql = ("insert into geo.structural_feature "
               "(feature_type, name, geom, attributes, source_key, confidence, trend_deg) values\n"
               + ",\n".join(vals) + ";\n")
        path = os.path.join(a.outdir, f"chunk_{n_chunks:03d}.sql")
        io.open(path, "w", encoding="utf-8").write(sql)
        n_chunks += 1

    print(f"features: {len(feats)} -> {n_chunks} chunk file(s) of up to {a.chunk} in {a.outdir}")


if __name__ == "__main__":
    main()

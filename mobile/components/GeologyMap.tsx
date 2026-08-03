// Offline geological map.
//
// Drawn entirely from the knowledge pack on the device — bedrock colours come
// from Macrostrat's own legend, faults from the mapped line layer, occurrences
// from MRDS, shading from the sampled DEM. There is no tile server and no
// basemap: the map works exactly where the guidance works, which is anywhere.
//
// Rendered as inline SVG inside a WebView. react-native-svg is not a dependency
// and adding a native module for this would be a heavier change than the map
// warrants; react-native-webview is already used elsewhere in the app. Nothing
// is loaded over the network — the SVG is a string built here.
import React from "react";
import { StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import { colors, radius } from "../lib/theme";
import type { MapView as GeoMapView } from "../lib/geo/mapView";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const path = (pts: Array<[number, number]>): string =>
  pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");

export function buildMapSvg(v: GeoMapView, labels: { you: string; target: string }): string {
  const parts: string[] = [];

  parts.push(`<rect width="${v.width}" height="${v.height}" fill="#0B0B0C"/>`);

  // Bedrock first: everything else reads against it.
  for (const p of v.polygons) {
    const d = p.rings.map((r) => `${path(r)} Z`).join(" ");
    parts.push(`<path d="${d}" fill="${esc(p.color)}" fill-opacity="0.55" stroke="${esc(p.color)}" stroke-opacity="0.9" stroke-width="0.5"/>`);
  }

  // Terrain as translucent relief dots — enough to read the shape of the ground
  // without pretending to be a hillshade we did not compute.
  for (const t of v.terrain) {
    const a = (0.10 + t.shade * 0.28).toFixed(2);
    parts.push(`<circle cx="${t.x.toFixed(1)}" cy="${t.y.toFixed(1)}" r="7" fill="#FFFFFF" fill-opacity="${a}"/>`);
  }

  // Faults: the structural signal, drawn boldly because it drives targeting.
  for (const l of v.lines) {
    for (const p of l.paths) {
      if (p.length < 2) continue;
      parts.push(`<path d="${path(p)}" fill="none" stroke="#FF6B4A" stroke-width="2" stroke-opacity="0.95" stroke-linecap="round"/>`);
    }
  }

  // Known occurrences.
  for (const p of v.points) {
    parts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5.5" fill="#C9A227" stroke="#0B0B0C" stroke-width="1.5"/>`);
  }

  // The line to the recommendation, then the target.
  if (v.target) {
    parts.push(`<line x1="${v.centre.x.toFixed(1)}" y1="${v.centre.y.toFixed(1)}" x2="${v.target.x.toFixed(1)}" y2="${v.target.y.toFixed(1)}" stroke="#C9A227" stroke-width="2.5" stroke-dasharray="7 5" stroke-opacity="0.95"/>`);
    parts.push(`<circle cx="${v.target.x.toFixed(1)}" cy="${v.target.y.toFixed(1)}" r="9" fill="none" stroke="#C9A227" stroke-width="2.5"/>`);
    parts.push(`<circle cx="${v.target.x.toFixed(1)}" cy="${v.target.y.toFixed(1)}" r="3" fill="#C9A227"/>`);
  }

  // You, last, so nothing can cover it.
  parts.push(`<circle cx="${v.centre.x.toFixed(1)}" cy="${v.centre.y.toFixed(1)}" r="11" fill="#2F6BD6" fill-opacity="0.25"/>`);
  parts.push(`<circle cx="${v.centre.x.toFixed(1)}" cy="${v.centre.y.toFixed(1)}" r="5.5" fill="#4A90E2" stroke="#FFFFFF" stroke-width="2"/>`);

  // Scale bar — a map without one cannot be used to judge a distance.
  const y = v.height - 16;
  const x = 14;
  parts.push(`<line x1="${x}" y1="${y}" x2="${x + v.scaleBar.px}" y2="${y}" stroke="#F5F1E8" stroke-width="2.5"/>`);
  parts.push(`<line x1="${x}" y1="${y - 4}" x2="${x}" y2="${y + 4}" stroke="#F5F1E8" stroke-width="2.5"/>`);
  parts.push(`<line x1="${x + v.scaleBar.px}" y1="${y - 4}" x2="${x + v.scaleBar.px}" y2="${y + 4}" stroke="#F5F1E8" stroke-width="2.5"/>`);
  parts.push(`<text x="${x + v.scaleBar.px + 7}" y="${y + 4}" fill="#F5F1E8" font-size="11" font-family="sans-serif">${v.scaleBar.km} km</text>`);

  parts.push(`<text x="${v.width - 10}" y="18" fill="#8A8A8E" font-size="10" text-anchor="end" font-family="sans-serif">N &#8593;</text>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${v.width}" height="${v.height}" viewBox="0 0 ${v.width} ${v.height}">${parts.join("")}</svg>`;
}

export function GeologyMap({ view, height = 260 }: { view: GeoMapView; height?: number }) {
  const svg = buildMapSvg(view, { you: "", target: "" });
  const html =
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>html,body{margin:0;padding:0;background:#0B0B0C;overflow:hidden}svg{display:block;width:100%;height:auto}</style>` +
    `</head><body>${svg}</body></html>`;

  return (
    <View style={[styles.wrap, { height }]}>
      <WebView
        originWhitelist={["*"]}
        source={{ html }}
        style={styles.web}
        scrollEnabled={false}
        // Nothing here is remote; keep the WebView from reaching out at all.
        javaScriptEnabled={false}
        domStorageEnabled={false}
        androidLayerType="hardware"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderRadius: radius.xl,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  web: { flex: 1, backgroundColor: colors.bg },
});

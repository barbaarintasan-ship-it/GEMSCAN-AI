// Waypoints out of the phone and into everything else.
//
// A field notebook nobody can read is not a record. GPX goes into Garmin and
// every handheld; CSV opens in Excel, which is what a mining ministry actually
// uses; GeoJSON goes into QGIS and ArcGIS, which is what a geologist uses. All
// three are written here rather than pulled in as dependencies, because the
// formats are small, stable, and a field app should not need a library to
// produce a text file.
//
// Pure string building — no filesystem, no sharing, no dates from `now`. That
// is what makes the output testable, and the output is a record that may be
// filed, cited or argued over.
import type { Waypoint } from "./waypointTypes";

/** Waypoints with no fix are excluded: a point with no position is not a point. */
function positioned(waypoints: readonly Waypoint[]): Waypoint[] {
  return waypoints.filter((w) => w.position && !w.deletedAt);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** XML text escape. Field notes contain ampersands and angle brackets. */
function xml(s: string): string {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * GPX 1.1.
 *
 * Coordinates carry six decimal places — about 0.1 m, well past any phone's
 * accuracy, and the point at which further digits are noise dressed as
 * precision. Elevation is written only when the fix reported one.
 */
export function toGpx(waypoints: readonly Waypoint[], creator = "LuulScan"): string {
  const pts = positioned(waypoints).map((w) => {
    const p = w.position!;
    const lines = [
      `  <wpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}">`,
      p.altitudeM != null ? `    <ele>${p.altitudeM.toFixed(1)}</ele>` : null,
      `    <time>${iso(w.capturedAt)}</time>`,
      `    <name>${xml(w.name || w.type)}</name>`,
      w.notes ? `    <desc>${xml(w.notes)}</desc>` : null,
      `    <type>${xml(w.type)}</type>`,
      // Horizontal dilution is not what the phone reports, so the accuracy in
      // metres goes in an extension rather than being crammed into <hdop>,
      // where it would be read as something it is not.
      p.accuracyM != null
        ? `    <extensions><luul:accuracyM>${p.accuracyM.toFixed(1)}</luul:accuracyM></extensions>`
        : null,
      `  </wpt>`,
    ].filter((l): l is string => l !== null);
    return lines.join("\n");
  });

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<gpx version="1.1" creator="${xml(creator)}" xmlns="http://www.topografix.com/GPX/1/1" xmlns:luul="https://luulscan.app/gpx">`,
    ...pts,
    `</gpx>`,
  ].join("\n");
}

/** CSV field quoting, RFC 4180: wrap in quotes and double any quote inside. */
function csvCell(v: string | number | null | undefined): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_COLUMNS = [
  "id", "name", "type", "latitude", "longitude", "altitude_m",
  "accuracy_m", "captured_at", "photos", "notes",
] as const;

export function toCsv(waypoints: readonly Waypoint[]): string {
  const rows = positioned(waypoints).map((w) => {
    const p = w.position!;
    return [
      w.id, w.name ?? "", w.type,
      p.lat.toFixed(6), p.lng.toFixed(6),
      p.altitudeM != null ? p.altitudeM.toFixed(1) : "",
      p.accuracyM != null ? p.accuracyM.toFixed(1) : "",
      iso(w.capturedAt),
      String(w.photos?.length ?? 0),
      w.notes ?? "",
    ].map(csvCell).join(",");
  });
  // CRLF: Excel on Windows is the most common destination, and it is the one
  // that cares.
  return [CSV_COLUMNS.join(","), ...rows].join("\r\n");
}

export function toGeoJson(waypoints: readonly Waypoint[]): string {
  const features = positioned(waypoints).map((w) => {
    const p = w.position!;
    return {
      type: "Feature" as const,
      geometry: {
        type: "Point" as const,
        // GeoJSON is [lng, lat] — the opposite order to everything a geologist
        // says out loud, and the most common way an export ends up in the sea.
        coordinates: p.altitudeM != null
          ? [Number(p.lng.toFixed(6)), Number(p.lat.toFixed(6)), p.altitudeM]
          : [Number(p.lng.toFixed(6)), Number(p.lat.toFixed(6))],
      },
      properties: {
        id: w.id,
        name: w.name,
        type: w.type,
        notes: w.notes || null,
        accuracy_m: p.accuracyM,
        captured_at: iso(w.capturedAt),
        photos: w.photos?.length ?? 0,
      },
    };
  });

  return JSON.stringify({
    type: "FeatureCollection",
    // WGS84 is the GeoJSON default and stating it is redundant, but an export
    // that lands on someone's desk should not make them guess.
    crs: { type: "name", properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" } },
    features,
  }, null, 2);
}

export type ExportFormat = "gpx" | "csv" | "geojson";

export function exportWaypoints(waypoints: readonly Waypoint[], format: ExportFormat): {
  content: string; filename: string; mimeType: string;
} {
  const stamp = new Date().toISOString().slice(0, 10);
  switch (format) {
    case "gpx":
      return { content: toGpx(waypoints), filename: `luulscan-waypoints-${stamp}.gpx`, mimeType: "application/gpx+xml" };
    case "csv":
      return { content: toCsv(waypoints), filename: `luulscan-waypoints-${stamp}.csv`, mimeType: "text/csv" };
    case "geojson":
      return { content: toGeoJson(waypoints), filename: `luulscan-waypoints-${stamp}.geojson`, mimeType: "application/geo+json" };
  }
}

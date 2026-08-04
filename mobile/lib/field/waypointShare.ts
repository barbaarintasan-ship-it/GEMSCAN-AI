// Getting the field notebook off the phone.
//
// waypointExport.ts turns waypoints into GPX, CSV and GeoJSON text and is
// deliberately pure — no filesystem, no share sheet — so the formats can be
// tested byte for byte. This is the thin, untestable half: write the text to a
// file and hand it to the OS.
//
// It goes through the SAME expo-sharing path the PDF reports already use, so a
// traverse exports to WhatsApp, email or Files exactly the way a scan report
// does. There is no upload and no account involved: a geologist's own
// observations are theirs, and getting them out must work with no signal.
import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";
import { exportWaypoints, type ExportFormat } from "./waypointExport";
import type { Waypoint } from "./waypointTypes";

export type ShareOutcome =
  | { ok: true; filename: string; count: number }
  | { ok: false; reason: "empty" | "unavailable" | "failed"; detail?: string };

/** Positioned, undeleted waypoints — the ones an export would actually contain. */
export function exportableCount(waypoints: readonly Waypoint[]): number {
  return waypoints.filter((w) => w.position && !w.deletedAt).length;
}

export async function shareWaypoints(
  waypoints: readonly Waypoint[],
  format: ExportFormat,
): Promise<ShareOutcome> {
  // An empty file is worse than a refusal: it looks like the traverse recorded
  // nothing, when what happened is that nothing had a fix yet.
  const count = exportableCount(waypoints);
  if (count === 0) return { ok: false, reason: "empty" };

  const { content, filename, mimeType } = exportWaypoints(waypoints, format);

  try {
    if (!(await Sharing.isAvailableAsync())) {
      return { ok: false, reason: "unavailable" };
    }
    // The cache directory, not documents: this file exists to be handed to
    // another app. The waypoints themselves are already stored durably by
    // WaypointStore, so nothing is lost when the OS reclaims it.
    const uri = `${FileSystem.cacheDirectory ?? ""}${filename}`;
    await FileSystem.writeAsStringAsync(uri, content, {
      encoding: FileSystem.EncodingType.UTF8,
    });
    await Sharing.shareAsync(uri, { mimeType, UTI: utiFor(format), dialogTitle: filename });
    return { ok: true, filename, count };
  } catch (e) {
    return { ok: false, reason: "failed", detail: String(e) };
  }
}

/**
 * iOS needs a Uniform Type Identifier as well as a MIME type, and gets the
 * destination list wrong without one. GPX and GeoJSON have no registered UTI,
 * so they declare what they actually are — XML and JSON — which is what makes
 * Files, Mail and the mapping apps accept them.
 */
function utiFor(format: ExportFormat): string {
  switch (format) {
    case "gpx": return "public.xml";
    case "csv": return "public.comma-separated-values-text";
    case "geojson": return "public.json";
  }
}

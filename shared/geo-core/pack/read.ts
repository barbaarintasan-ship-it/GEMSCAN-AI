// Pack reader — verified files → typed PackData (Stage E1).
//
// Reading is deliberately separate from verifying: nothing here re-checks
// integrity, because verifyPack() must have already passed. Keeping them apart
// means there is exactly one place that decides a pack is trustworthy.
import { MANIFEST_FILE, PACK_FILES, type PackData, type PackManifest } from "./types.ts";

export interface LoadedPack {
  manifest: PackManifest;
  data: PackData;
}

interface FileEnvelope {
  kind: string;
  formatVersion: number;
  rows: unknown[];
}

function rowsOf(files: Record<string, string>, file: string, kind: string): unknown[] {
  const raw = files[file];
  if (raw === undefined) return [];
  const parsed = JSON.parse(raw) as FileEnvelope;
  if (!parsed || parsed.kind !== kind || !Array.isArray(parsed.rows)) {
    // A file whose envelope disagrees with its name means the pack was
    // assembled wrongly; an empty list would hide that as "no data here".
    throw new Error(`pack file ${file}: expected kind "${kind}", got "${parsed?.kind}"`);
  }
  return parsed.rows;
}

/** Parse a pack that has ALREADY passed verifyPack(). */
export function readPack(files: Record<string, string>): LoadedPack {
  const manifest = JSON.parse(files[MANIFEST_FILE]) as PackManifest;
  return {
    manifest,
    data: {
      geology: rowsOf(files, PACK_FILES.geology, "geology") as PackData["geology"],
      occurrences: rowsOf(files, PACK_FILES.occurrences, "occurrences") as PackData["occurrences"],
      knowledge: rowsOf(files, PACK_FILES.knowledge, "knowledge") as PackData["knowledge"],
      structures: rowsOf(files, PACK_FILES.structures, "structures") as PackData["structures"],
      community: rowsOf(files, PACK_FILES.community, "community") as PackData["community"],
      mapFeatures: rowsOf(files, PACK_FILES.mapFeatures, "mapFeatures") as PackData["mapFeatures"],
      terrain: rowsOf(files, PACK_FILES.terrain, "terrain") as PackData["terrain"],
      associations: rowsOf(files, PACK_FILES.associations, "associations") as PackData["associations"],
      rules: rowsOf(files, PACK_FILES.rules, "rules") as PackData["rules"],
      commodities: rowsOf(files, PACK_FILES.commodities, "commodities") as PackData["commodities"],
      assemblages: rowsOf(files, PACK_FILES.assemblages, "assemblages") as PackData["assemblages"],
      // OPTIONAL. A pack built before the coastline existed is still a valid
      // pack, and must load rather than be refused for lacking a file it was
      // never built with. Absent means "cannot tell land from sea", which the
      // callers already handle, not "everything is sea".
      land: files[PACK_FILES.land] === undefined
        ? []
        : rowsOf(files, PACK_FILES.land, "land") as PackData["land"],
    },
  };
}

/** Empty pack — the honest answer when nothing is installed, never a fabricated one. */
export function emptyPackData(): PackData {
  return {
    geology: [], occurrences: [], knowledge: [], structures: [], community: [],
    mapFeatures: [], terrain: [],
    associations: [], rules: [], commodities: [], assemblages: [], land: [],
  };
}

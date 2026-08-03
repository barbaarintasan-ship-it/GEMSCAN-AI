// Pack builder — pure and deterministic (Architecture §7.2, Stage E1).
//
// Takes source rows and produces the exact file bytes plus a manifest. It does
// no I/O: the CLI (scripts/build-geo-pack.ts) reads geo.* and writes files, so
// the determinism this module guarantees is unit-testable without a database.
//
// E1's exit criterion: identical input ⇒ identical sha256. That is achieved by
// (1) canonical JSON, and (2) sorting every collection by a stable key here,
// so a change in row order coming out of Postgres cannot change the artifact.
import { canonicalJson } from "./canonical.ts";
import { sha256Hex } from "./sha256.ts";
import {
  MANIFEST_FILE,
  PACK_FILES,
  PACK_FORMAT_VERSION,
  type BuiltPack,
  type PackData,
  type PackDatasetRef,
  type PackManifest,
} from "./types.ts";

export interface BuildPackOptions {
  packId: string;
  packVersion: string;
  engineVersion: string;
  region: string;
  h3Resolution: number;
  /** Injected so the build is reproducible and testable; never Date.now() inline. */
  builtAt: string;
  datasets: PackDatasetRef[];
}

const byId = <T extends { id: string }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const byKey = <T>(rows: T[], key: (r: T) => string): T[] =>
  [...rows].sort((a, b) => {
    const ka = key(a), kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

/** Envelope keeps a file self-describing, so a stray file can never be mistaken for another. */
function fileBody(kind: string, rows: unknown[]): string {
  return canonicalJson({ kind, formatVersion: PACK_FORMAT_VERSION, rows });
}

function computeBbox(data: PackData): [number, number, number, number] | null {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  const point = (lng: number, lat: number) => {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  };
  for (const g of data.geology) {
    point(g.bbox[0], g.bbox[1]);
    point(g.bbox[2], g.bbox[3]);
  }
  for (const o of data.occurrences) point(o.lng, o.lat);
  for (const k of data.knowledge) point(k.lng, k.lat);
  for (const s of data.structures) point(s.lng, s.lat);
  for (const c of data.community) point(c.lng, c.lat);
  return Number.isFinite(minLng) ? [minLng, minLat, maxLng, maxLat] : null;
}

/**
 * Build a pack. Pure: same input, same `builtAt`, same bytes, same hash.
 */
export function buildPack(data: PackData, opts: BuildPackOptions): BuiltPack {
  // Sort everything: Postgres row order is not a contract.
  const sorted: PackData = {
    geology: byId(data.geology),
    occurrences: byId(data.occurrences),
    knowledge: byId(data.knowledge),
    structures: byId(data.structures),
    community: byKey(data.community, (c) => c.cell),
    associations: byKey(data.associations, (a) => `${a.commodity_code}|${a.host_rock_code}`),
    rules: byId(data.rules),
    commodities: byKey(data.commodities, (c) => c.code),
    assemblages: byId(data.assemblages),
  };

  const files: Record<string, string> = {
    [PACK_FILES.geology]: fileBody("geology", sorted.geology),
    [PACK_FILES.occurrences]: fileBody("occurrences", sorted.occurrences),
    [PACK_FILES.knowledge]: fileBody("knowledge", sorted.knowledge),
    [PACK_FILES.structures]: fileBody("structures", sorted.structures),
    [PACK_FILES.community]: fileBody("community", sorted.community),
    [PACK_FILES.associations]: fileBody("associations", sorted.associations),
    [PACK_FILES.rules]: fileBody("rules", sorted.rules),
    [PACK_FILES.commodities]: fileBody("commodities", sorted.commodities),
    [PACK_FILES.assemblages]: fileBody("assemblages", sorted.assemblages),
  };

  const fileHashes: Record<string, string> = {};
  for (const name of Object.keys(files).sort()) fileHashes[name] = sha256Hex(files[name]);

  const manifest: PackManifest = {
    packId: opts.packId,
    packVersion: opts.packVersion,
    formatVersion: PACK_FORMAT_VERSION,
    engineVersion: opts.engineVersion,
    region: opts.region,
    builtAt: opts.builtAt,
    h3Resolution: opts.h3Resolution,
    bbox: computeBbox(sorted),
    datasets: byKey(opts.datasets, (d) => `${d.source}|${d.version ?? ""}`),
    counts: {
      geology: sorted.geology.length,
      occurrences: sorted.occurrences.length,
      knowledge: sorted.knowledge.length,
      structures: sorted.structures.length,
      community: sorted.community.length,
      associations: sorted.associations.length,
      rules: sorted.rules.length,
      commodities: sorted.commodities.length,
      assemblages: sorted.assemblages.length,
    },
    files: fileHashes,
    // One value covering every file — the single thing a verifier must trust.
    sha256: sha256Hex(canonicalJson(fileHashes)),
    signature: null,
  };

  return {
    manifest,
    files: { ...files, [MANIFEST_FILE]: canonicalJson(manifest) },
  };
}

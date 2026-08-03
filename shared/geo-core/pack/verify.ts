// Pack verification (Architecture §7.5, Invariant 6).
//
// "A pack that fails integrity verification is refused, not degraded."
// Fabricated geology is the one failure mode this product cannot tolerate, so
// every check returns a typed reason rather than throwing or, worse, warning
// and continuing. The caller cannot accidentally use a bad pack: it gets a
// result object, not an exception it might swallow.
import { canonicalJson } from "./canonical.ts";
import { sha256Hex } from "./sha256.ts";
import { MANIFEST_FILE, PACK_FORMAT_VERSION, type PackManifest } from "./types.ts";

export type VerifyFailure =
  | { code: "manifest-unreadable"; detail: string }
  | { code: "format-unsupported"; detail: string }
  | { code: "engine-unsupported"; detail: string }
  | { code: "file-missing"; detail: string }
  | { code: "file-corrupt"; detail: string }
  | { code: "manifest-corrupt"; detail: string };

export type VerifyResult =
  | { ok: true; manifest: PackManifest }
  | { ok: false; failure: VerifyFailure };

export interface VerifyOptions {
  /** Inclusive engine-version range this build of the app understands. */
  supportedEngineVersions?: { min: string; max: string };
  /**
   * Skip per-file sha256 comparison. Set ONLY when the caller cannot supply the
   * pack's original bytes — the APK-bundled pack, which the platform hands over
   * as parsed JSON. Everything else is still checked: the manifest must be
   * readable and self-consistent, the format and engine version supported, and
   * every declared file present. Provenance replaces the hash there (§7.5); a
   * downloaded pack must never set this.
   */
  skipFileHashes?: boolean;
}

/** Numeric-aware compare so "1.10.0" sorts after "1.9.0", unlike a string compare. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Verify a pack from its raw files.
 *
 * @param files filename → exact content as read from disk/bundle.
 */
export function verifyPack(files: Record<string, string>, opts: VerifyOptions = {}): VerifyResult {
  const rawManifest = files[MANIFEST_FILE];
  if (rawManifest === undefined) {
    return { ok: false, failure: { code: "manifest-unreadable", detail: `${MANIFEST_FILE} missing` } };
  }

  let manifest: PackManifest;
  try {
    manifest = JSON.parse(rawManifest) as PackManifest;
  } catch (e) {
    return { ok: false, failure: { code: "manifest-unreadable", detail: String(e) } };
  }
  if (!manifest || typeof manifest !== "object" || !manifest.files || typeof manifest.sha256 !== "string") {
    return { ok: false, failure: { code: "manifest-unreadable", detail: "manifest missing required fields" } };
  }

  if (manifest.formatVersion !== PACK_FORMAT_VERSION) {
    // Refused, not coerced: misreading a pack is worse than lacking one.
    return {
      ok: false,
      failure: {
        code: "format-unsupported",
        detail: `pack format ${manifest.formatVersion}, this build reads ${PACK_FORMAT_VERSION}`,
      },
    };
  }

  const range = opts.supportedEngineVersions;
  if (range) {
    const v = manifest.engineVersion;
    if (compareVersions(v, range.min) < 0 || compareVersions(v, range.max) > 0) {
      return {
        ok: false,
        failure: {
          code: "engine-unsupported",
          detail: `pack engineVersion ${v} outside supported ${range.min}..${range.max}`,
        },
      };
    }
  }

  // The manifest's own file map must be intact before any file hash is trusted.
  const expectedMapHash = sha256Hex(canonicalJson(manifest.files));
  if (expectedMapHash !== manifest.sha256) {
    return {
      ok: false,
      failure: { code: "manifest-corrupt", detail: "sha256 does not cover the declared file map" },
    };
  }

  for (const name of Object.keys(manifest.files).sort()) {
    const content = files[name];
    // Presence is checked even when hashes are not: a pack missing a file is
    // incomplete however it was delivered.
    if (content === undefined) {
      return { ok: false, failure: { code: "file-missing", detail: name } };
    }
    if (opts.skipFileHashes) continue;
    if (sha256Hex(content) !== manifest.files[name]) {
      return { ok: false, failure: { code: "file-corrupt", detail: name } };
    }
  }

  return { ok: true, manifest };
}

/** Human-readable reason, for the diagnostics surface and the pack-refused UI. */
export function describeFailure(f: VerifyFailure): string {
  switch (f.code) {
    case "manifest-unreadable": return `Pack manifest could not be read (${f.detail})`;
    case "format-unsupported": return `Pack format not supported by this app version (${f.detail})`;
    case "engine-unsupported": return `Pack built for a different engine version (${f.detail})`;
    case "file-missing": return `Pack is incomplete — missing ${f.detail}`;
    case "file-corrupt": return `Pack file failed integrity check — ${f.detail}`;
    case "manifest-corrupt": return "Pack manifest failed its own integrity check";
  }
}

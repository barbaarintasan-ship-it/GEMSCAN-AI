// The knowledge pack shipped inside the app bundle (Architecture §7.2).
//
// The pack is built from geo.* by scripts/build-geo-pack.ts and written to
// mobile/assets/geo-pack/. Metro resolves `require` of a JSON asset at BUILD
// time, so the files must be listed statically — a dynamic path would silently
// produce nothing.
//
// A missing pack is a NORMAL state, not a crash: the app then says it has no
// knowledge here rather than extrapolating (§3.9). That is why every require
// is guarded rather than assumed.
import {
  MANIFEST_FILE, PACK_FILES, type PackFile,
} from "../../../shared/geo-core/pack/types.ts";
import { markPhase } from "../diagnostics/jsStall";

/**
 * Metro inlines these requires at build time. `require` of a missing file is a
 * bundling error rather than a runtime one, so the whole set is wrapped: if the
 * pack has not been built yet the app still runs, with no knowledge.
 */
function tryRequireAll(): Record<string, unknown> | null {
  // ~17 MB of JSON across thirteen files. Metro turns each into a JS module, so
  // `require` here is not a file read — it is Hermes constructing the objects,
  // synchronously, on this thread. Named so a stall lands attributed.
  const done = markPhase("pack.require");
  try {
    /* eslint-disable @typescript-eslint/no-var-requires */
    return {
      [MANIFEST_FILE]: require("../../assets/geo-pack/manifest.json"),
      [PACK_FILES.geology]: require("../../assets/geo-pack/geology.json"),
      [PACK_FILES.occurrences]: require("../../assets/geo-pack/occurrences.json"),
      [PACK_FILES.knowledge]: require("../../assets/geo-pack/knowledge.json"),
      [PACK_FILES.structures]: require("../../assets/geo-pack/structures.json"),
      [PACK_FILES.community]: require("../../assets/geo-pack/community.json"),
      [PACK_FILES.mapFeatures]: require("../../assets/geo-pack/maplayers.json"),
      [PACK_FILES.terrain]: require("../../assets/geo-pack/terrain.json"),
      [PACK_FILES.associations]: require("../../assets/geo-pack/associations.json"),
      [PACK_FILES.rules]: require("../../assets/geo-pack/rules.json"),
      [PACK_FILES.commodities]: require("../../assets/geo-pack/commodities.json"),
      [PACK_FILES.assemblages]: require("../../assets/geo-pack/assemblages.json"),
      [PACK_FILES.land]: require("../../assets/geo-pack/land.json"),
    };
    /* eslint-enable @typescript-eslint/no-var-requires */
  } catch {
    return null;
  } finally {
    done();
  }
}

/**
 * Pack files as EXACT strings.
 *
 * Metro parses a required .json into an object, but verification hashes bytes,
 * and re-serialising a parsed object would not reproduce them — key order and
 * spacing would differ. The pack is written as canonical JSON (sorted keys, no
 * insignificant whitespace), so re-serialising with the SAME canonicalJson the
 * builder used reproduces the bytes exactly and the sha256 still verifies.
 * Using the shared function rather than a copy is what guarantees that.
 */
export function loadBundledPackFiles(): Record<string, PackFile> | null {
  // `tryRequireAll` already marks pack.require, which is where the time actually
  // goes now: Hermes materialising seventeen megabytes from bytecode.
  const done = markPhase("pack.handover");
  try {
    const raw = tryRequireAll();
    if (!raw) return null;
    const files: Record<string, PackFile> = {};
    for (const [name, value] of Object.entries(raw)) {
      if (value == null) return null;
      // HANDED OVER AS IT IS.
      //
      // This used to `JSON.stringify` every file so the reader could parse them
      // straight back. The round trip existed for one reason: verifyPack hashes
      // bytes. But the bundled source sets `bytesAreExact: false`, so PackStore
      // passes `skipFileHashes` and no hash is ever computed — seventeen
      // megabytes serialised and re-parsed to satisfy a check that is switched
      // off.
      //
      // Measured on an SM-A165F, inside a four-second cold-start block:
      //   pack.stringify  656 ms
      //   pack.read       527 ms
      //
      // Metro compiled these into the app and Hermes has already materialised
      // them. readPack now accepts the object, so nothing is converted at all.
      // A DOWNLOADED pack still arrives as bytes and still has its hash checked;
      // that path does not come through here.
      files[name] = value as PackFile;
    }
    return files;
  } finally {
    done();
  }
}

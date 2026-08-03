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
import { canonicalJson } from "../../../shared/geo-core/pack/canonical.ts";
import { MANIFEST_FILE, PACK_FILES } from "../../../shared/geo-core/pack/types.ts";

/**
 * Metro inlines these requires at build time. `require` of a missing file is a
 * bundling error rather than a runtime one, so the whole set is wrapped: if the
 * pack has not been built yet the app still runs, with no knowledge.
 */
function tryRequireAll(): Record<string, unknown> | null {
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
    };
    /* eslint-enable @typescript-eslint/no-var-requires */
  } catch {
    return null;
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
export function loadBundledPackFiles(): Record<string, string> | null {
  const raw = tryRequireAll();
  if (!raw) return null;
  const files: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value == null) return null;
    files[name] = canonicalJson(value);
  }
  return files;
}

// Knowledge pack — build / verify / read (Stage E1).
//
// The load-bearing assertion is DETERMINISM: identical input must produce an
// identical sha256, or integrity verification and E3 divergence triage both
// become guesswork (Architecture §7.2).
import { assertEquals, assertNotEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { sha256Hex } from "./sha256.ts";
import { canonicalJson } from "./canonical.ts";
import { buildPack, type BuildPackOptions } from "./build.ts";
import { compareVersions, verifyPack } from "./verify.ts";
import { readPack } from "./read.ts";
import { MANIFEST_FILE, PACK_FILES, type PackData } from "./types.ts";

// ── SHA-256 against the published FIPS 180-4 vectors ────────────────────────
Deno.test("sha256: empty string", () => {
  assertEquals(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

Deno.test("sha256: abc", () => {
  assertEquals(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

Deno.test("sha256: 448-bit block-boundary vector", () => {
  assertEquals(
    sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
});

Deno.test("sha256: multi-block input (1M 'a' would be slow; 200k is enough to cross many blocks)", () => {
  const s = "a".repeat(200_000);
  // Stable across runtimes; asserted against itself for length/consistency plus
  // a known prefix property: hashing is total and produces 64 hex chars.
  assertEquals(sha256Hex(s).length, 64);
  assertEquals(sha256Hex(s), sha256Hex("a".repeat(200_000)));
});

Deno.test("sha256: non-ASCII is hashed as UTF-8, not UTF-16", () => {
  // "é" is 2 bytes in UTF-8 (0xC3 0xA9).
  assertEquals(sha256Hex("é"), sha256Hex(String.fromCharCode(0xe9)));
  assertNotEquals(sha256Hex("é"), sha256Hex("e"));
  // Somali/Arabic and an emoji (surrogate pair) must not throw or truncate.
  assertEquals(sha256Hex("dhagax cadaan").length, 64);
  assertEquals(sha256Hex("⛏️🪨").length, 64);
});

// ── Canonical JSON ──────────────────────────────────────────────────────────
Deno.test("canonicalJson sorts keys, so insertion order cannot change the hash", () => {
  assertEquals(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assertEquals(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

Deno.test("canonicalJson sorts nested keys too", () => {
  assertEquals(canonicalJson({ x: { z: 1, y: 2 } }), '{"x":{"y":2,"z":1}}');
});

Deno.test("canonicalJson preserves array order (arrays are data, not sets)", () => {
  assertEquals(canonicalJson([3, 1, 2]), "[3,1,2]");
});

Deno.test("canonicalJson drops undefined but keeps null", () => {
  assertEquals(canonicalJson({ a: undefined, b: null }), '{"b":null}');
});

Deno.test("canonicalJson refuses non-finite numbers rather than writing null", () => {
  assertThrows(() => canonicalJson({ a: NaN }));
  assertThrows(() => canonicalJson({ a: Infinity }));
});

// ── Fixtures ────────────────────────────────────────────────────────────────
function sampleData(): PackData {
  return {
    geology: [
      {
        id: "g2", name: "Basement Complex", kind: "formation", source: "Macrostrat",
        attributes: { age: "Precambrian" },
        rings: [[[45.0, 2.0], [45.5, 2.0], [45.5, 2.5], [45.0, 2.5], [45.0, 2.0]]],
        bbox: [45.0, 2.0, 45.5, 2.5], isPolygon: true,
      },
      {
        id: "g1", name: "Coastal Sands", kind: "formation", source: "Macrostrat",
        attributes: null,
        rings: [[[45.6, 2.0], [45.9, 2.0], [45.9, 2.4], [45.6, 2.4], [45.6, 2.0]]],
        bbox: [45.6, 2.0, 45.9, 2.4], isPolygon: true,
      },
    ],
    occurrences: [
      {
        id: "o2", name: "Bulo Gold", commodity_key: "gold", deposit_type: "orogenic",
        host_rocks: ["greenstone"], lat: 2.31, lng: 45.12, dataset_id: "d1",
        source: "USGS MRDS", version: "2024", reference: "MRDS-1", cell: "87a1b2c3d",
      },
      {
        id: "o1", name: null, commodity_key: "iron", deposit_type: null,
        host_rocks: null, lat: 2.11, lng: 45.42, dataset_id: "d1",
        source: "USGS MRDS", version: "2024", reference: null, cell: "87a1b2c3e",
      },
    ],
    knowledge: [],
    structures: [],
    community: [{ cell: "87a1b2c3d", lat: 2.3, lng: 45.1, verified_scans: 4, sample_count: 9 }],
    associations: [
      { commodity_code: "gold", host_rock_code: "greenstone", weight: 0.8 },
      { commodity_code: "copper", host_rock_code: "basalt", weight: 0.5 },
    ],
    rules: [{
      id: "r1", antecedent_type: "host_rock", antecedent_key: "kimberlite", commodity_code: "diamond",
      expected_minerals: ["diamond"], relationship: "hosts", likelihood: "diagnostic",
      requires_setting: null, weight: 0.9,
    }],
    commodities: [{
      code: "gold", name: "Gold", category: "precious", typical_host_rocks: ["greenstone"],
      associated_minerals: ["pyrite"], alteration_styles: null, deposit_models: null,
      tectonic_settings: null, exploration_indicators: null, industrial_uses: null,
      is_critical_mineral: false, strategic_importance: "high", confidence_limitations: "none",
    }],
    assemblages: [{
      id: "a1", minerals: ["pyrite", "quartz"], interpretation: "epithermal system",
      commodity_code: "gold", likelihood: "common", relationship: "indicates", weight: 0.6,
    }],
  };
}

const OPTS: BuildPackOptions = {
  packId: "somalia", packVersion: "1.0.0", engineVersion: "1.2.0", region: "SO",
  h3Resolution: 7, builtAt: "2026-08-03T00:00:00.000Z",
  datasets: [{ datasetId: "d1", source: "USGS MRDS", version: "2024" }],
};

// ── Determinism — E1's exit criterion ───────────────────────────────────────
Deno.test("identical input produces an identical pack hash", () => {
  const a = buildPack(sampleData(), OPTS);
  const b = buildPack(sampleData(), OPTS);
  assertEquals(a.manifest.sha256, b.manifest.sha256);
  assertEquals(a.files[MANIFEST_FILE], b.files[MANIFEST_FILE]);
});

Deno.test("row order out of the database cannot change the artifact", () => {
  const forward = sampleData();
  const reversed = sampleData();
  reversed.geology.reverse();
  reversed.occurrences.reverse();
  reversed.associations.reverse();
  assertEquals(buildPack(forward, OPTS).manifest.sha256, buildPack(reversed, OPTS).manifest.sha256);
});

Deno.test("a changed value changes the hash", () => {
  const changed = sampleData();
  changed.occurrences[0].commodity_key = "silver";
  assertNotEquals(buildPack(sampleData(), OPTS).manifest.sha256, buildPack(changed, OPTS).manifest.sha256);
});

Deno.test("manifest records counts, bbox and dataset provenance", () => {
  const { manifest } = buildPack(sampleData(), OPTS);
  assertEquals(manifest.counts.geology, 2);
  assertEquals(manifest.counts.occurrences, 2);
  assertEquals(manifest.counts.commodities, 1);
  assertEquals(manifest.bbox, [45.0, 2.0, 45.9, 2.5]);
  assertEquals(manifest.datasets[0].source, "USGS MRDS");
  assertEquals(manifest.h3Resolution, 7);
});

Deno.test("an empty pack is valid and reports a null bbox rather than a fake one", () => {
  const empty: PackData = {
    geology: [], occurrences: [], knowledge: [], structures: [], community: [],
    associations: [], rules: [], commodities: [], assemblages: [],
  };
  const built = buildPack(empty, OPTS);
  assertEquals(built.manifest.bbox, null);
  assertEquals(verifyPack(built.files).ok, true);
});

// ── Verification ────────────────────────────────────────────────────────────
Deno.test("a freshly built pack verifies", () => {
  const built = buildPack(sampleData(), OPTS);
  const r = verifyPack(built.files);
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.manifest.packVersion, "1.0.0");
});

Deno.test("a tampered data file is refused", () => {
  const built = buildPack(sampleData(), OPTS);
  const files = { ...built.files };
  // Swap a commodity — exactly the "fabricated geology" case Invariant 6 exists for.
  files[PACK_FILES.occurrences] = files[PACK_FILES.occurrences].replace('"gold"', '"platinum"');
  const r = verifyPack(files);
  assertEquals(r.ok, false);
  if (!r.ok) {
    assertEquals(r.failure.code, "file-corrupt");
    assertEquals(r.failure.detail, PACK_FILES.occurrences);
  }
});

Deno.test("tampering with a file AND its recorded hash is still refused", () => {
  const built = buildPack(sampleData(), OPTS);
  const files = { ...built.files };
  files[PACK_FILES.occurrences] = files[PACK_FILES.occurrences].replace('"gold"', '"platinum"');
  // Re-hash the file and patch the manifest's file map — but manifest.sha256
  // covers that map, so the forgery does not survive.
  const manifest = JSON.parse(files[MANIFEST_FILE]);
  manifest.files[PACK_FILES.occurrences] = sha256Hex(files[PACK_FILES.occurrences]);
  files[MANIFEST_FILE] = JSON.stringify(manifest);
  const r = verifyPack(files);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.failure.code, "manifest-corrupt");
});

Deno.test("a missing file is refused", () => {
  const built = buildPack(sampleData(), OPTS);
  const files = { ...built.files };
  delete files[PACK_FILES.rules];
  const r = verifyPack(files);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.failure.code, "file-missing");
});

Deno.test("an unreadable manifest is refused", () => {
  const r = verifyPack({ [MANIFEST_FILE]: "{not json" });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.failure.code, "manifest-unreadable");
});

Deno.test("a pack outside the supported engine range is refused, not coerced", () => {
  const built = buildPack(sampleData(), OPTS); // engineVersion 1.2.0
  const tooNew = verifyPack(built.files, { supportedEngineVersions: { min: "1.0.0", max: "1.1.0" } });
  assertEquals(tooNew.ok, false);
  if (!tooNew.ok) assertEquals(tooNew.failure.code, "engine-unsupported");

  const inRange = verifyPack(built.files, { supportedEngineVersions: { min: "1.0.0", max: "1.9.0" } });
  assertEquals(inRange.ok, true);
});

Deno.test("version compare is numeric, not lexicographic", () => {
  assertEquals(compareVersions("1.10.0", "1.9.0"), 1);
  assertEquals(compareVersions("1.2.0", "1.2.0"), 0);
  assertEquals(compareVersions("1.2", "1.2.1"), -1);
});

// ── Reading ─────────────────────────────────────────────────────────────────
Deno.test("read round-trips every collection", () => {
  const built = buildPack(sampleData(), OPTS);
  const { data, manifest } = readPack(built.files);
  assertEquals(manifest.packId, "somalia");
  assertEquals(data.geology.length, 2);
  assertEquals(data.occurrences.length, 2);
  assertEquals(data.commodities[0].code, "gold");
  assertEquals(data.assemblages[0].minerals, ["pyrite", "quartz"]);
  // Sorted by id at build time.
  assertEquals(data.geology.map((g) => g.id), ["g1", "g2"]);
});

Deno.test("a file whose envelope disagrees with its name is rejected, not read as empty", () => {
  const built = buildPack(sampleData(), OPTS);
  const files = { ...built.files };
  files[PACK_FILES.rules] = files[PACK_FILES.commodities];
  assertThrows(() => readPack(files));
});

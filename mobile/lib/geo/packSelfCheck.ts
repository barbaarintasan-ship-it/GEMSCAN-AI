// Does the pack work on THIS device?
//
// Everything else that verifies the pack runs on a development machine: Jest on
// Node, a grep over the bundle. Neither executes on Hermes, and the one time
// this mattered the pack was perfect on the desk and refused on the phone —
// the device re-serialised Metro's parsed JSON and the bytes no longer matched
// a hash computed by Deno.
//
// So the device answers for itself, at startup, and the answer is a value the
// diagnostics screen can show. This is a REPORT, not a repair: it changes
// nothing about how the pack loads, and a failure here surfaces the reason
// rather than working around it.
import { PackStore, createBundledPackSource } from "./packStore";
import { loadBundledPackFiles } from "./bundledPack";
import { makePackGateway } from "./packGateway";
import { MANIFEST_FILE } from "../../../shared/geo-core/pack/types.ts";

/** A point that must resolve to mapped geology if the pack is working at all. */
const PROBE = { name: "Mogadishu", lat: 2.0469, lng: 45.3182 };

export interface PackSelfCheck {
  ok: boolean;
  /** One line, already readable, for the diagnostics screen and the logs. */
  summary: string;
  manifestFound: boolean;
  filesShipped: number;
  filesDeclared: number;
  loadState: string;
  packVersion: string | null;
  counts: { geology: number; occurrences: number; faults: number; terrain: number };
  /** The unit the probe resolved to, or null if the pack could not answer. */
  probeUnit: string | null;
  /** Populated only on failure, so a bad build says WHY on the device. */
  problem: string | null;
}

export async function runPackSelfCheck(): Promise<PackSelfCheck> {
  const fail = (problem: string, partial: Partial<PackSelfCheck> = {}): PackSelfCheck => ({
    ok: false,
    summary: `Knowledge pack NOT usable — ${problem}`,
    manifestFound: false, filesShipped: 0, filesDeclared: 0,
    loadState: "unknown", packVersion: null,
    counts: { geology: 0, occurrences: 0, faults: 0, terrain: 0 },
    probeUnit: null, problem,
    ...partial,
  });

  let files: Record<string, string> | null;
  try {
    files = loadBundledPackFiles();
  } catch (e) {
    return fail(`the pack could not be read from the bundle (${String(e)})`);
  }
  if (!files) return fail("no pack is bundled with this build");

  const rawManifest = files[MANIFEST_FILE];
  if (!rawManifest) return fail("the pack manifest is missing");

  let declared: string[];
  try {
    declared = Object.keys(JSON.parse(rawManifest).files ?? {});
  } catch (e) {
    return fail(`the manifest is not readable (${String(e)})`, { manifestFound: true });
  }

  const shipped = Object.keys(files).filter((f) => f !== MANIFEST_FILE);
  const missing = declared.filter((d) => !shipped.includes(d));
  const base = {
    manifestFound: true,
    filesShipped: shipped.length,
    filesDeclared: declared.length,
  };
  if (missing.length) {
    return fail(`the build is missing ${missing.length} pack file(s): ${missing.join(", ")}`, base);
  }

  const store = new PackStore(createBundledPackSource(() => files));
  const status = await store.load();
  if (status.state !== "ready") {
    return fail(
      status.state === "refused" ? status.reason : "the pack did not load",
      { ...base, loadState: status.state },
    );
  }

  const data = store.getData();
  const counts = {
    geology: data.geology.length,
    occurrences: data.occurrences.length,
    faults: data.mapFeatures.filter((f) => f.kind === "fault").length,
    terrain: data.terrain.length,
  };

  // The end-to-end question: standing on real Somali ground, does the pack
  // name the rock? This is the exact lookup the screen makes, so a null here
  // is the sentence a geologist would read.
  const rows = await makePackGateway(data).geologyAt(PROBE.lat, PROBE.lng);
  const probeUnit = rows[0]?.name ?? null;
  if (!probeUnit) {
    return fail(
      `the pack loaded but reports no geology at ${PROBE.name} — its coverage does not match its manifest`,
      { ...base, loadState: status.state, packVersion: status.manifest.packVersion, counts },
    );
  }

  return {
    ok: true,
    summary:
      `Knowledge pack ${status.manifest.packVersion} loaded — ` +
      `${counts.geology} units, ${counts.occurrences} occurrences, ` +
      `${counts.faults} faults, ${counts.terrain} terrain cells. ` +
      `${PROBE.name} resolves to "${probeUnit}".`,
    ...base,
    loadState: status.state,
    packVersion: status.manifest.packVersion,
    counts,
    probeUnit,
    problem: null,
  };
}

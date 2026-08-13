// The phone runs a different JavaScript engine than the tests do.
//
// WHY THIS FILE EXISTS. `shared/geo-core/fusion.ts` built its result with
// `structuredClone(EMPTY)`. Node has `structuredClone`; Hermes, the engine React
// Native actually runs, does not. So `fuse()` — the whole offline GeoContext
// fusion — threw `ReferenceError: Property 'structuredClone' doesn't exist` on
// every single call, on a real phone, while every test passed.
//
// It was found in logcat on the device, not here: ninety-one unhandled
// rejections and climbing, about one a second, because the exploration screen
// calls fuse on a timer. Nothing in the suite could see it, because the suite
// runs on Node.
//
// A behavioural test cannot close this gap — it would pass for the same reason
// the bug survived. So the rule is asserted against the SOURCE, like the
// map-first architecture guard: these identifiers must not appear in code that
// ships to the device, whatever the test environment happens to support.
import * as fs from "fs";
import * as path from "path";

const ROOT = path.join(__dirname, "..", "..", "..");

/**
 * Globals absent from Hermes that a Node-based test suite will never flag.
 *
 * Each is here because it is genuinely missing (or was, in the Hermes shipped
 * with this Expo SDK) and because a plausible library or habit reaches for it.
 * Add to this list rather than discovering the next one in a wadi.
 */
const ABSENT_IN_HERMES = [
  "structuredClone",
  "queueMicrotask",
  "AbortSignal.timeout",
  "Object.groupBy",
  "Array.fromAsync",
];

/** Source that ships to the phone. Tests and node scripts are not shipped. */
const SHIPPED_DIRS = [
  path.join(ROOT, "shared", "geo-core"),
  path.join(ROOT, "mobile", "lib"),
  path.join(ROOT, "mobile", "components"),
  path.join(ROOT, "mobile", "app"),
];

function sourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Source with comments stripped — this file names the very identifiers it bans. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\/\/.*$/gm, "");

const files = SHIPPED_DIRS.flatMap(sourceFiles);

describe("no shipped code depends on a global Hermes does not have", () => {
  test("there is shipped source to check at all", () => {
    // A guard on the guard: a wrong path here would make every test below pass
    // by looking at nothing.
    expect(files.length).toBeGreaterThan(50);
  });

  for (const api of ABSENT_IN_HERMES) {
    test(`${api} is not used`, () => {
      const offenders: string[] = [];
      for (const file of files) {
        const src = code(fs.readFileSync(file, "utf8"));
        // Word-boundary match on the call, so `myStructuredCloneHelper` is fine
        // and `structuredClone(` is not.
        const pattern = new RegExp(`(^|[^.\\w])${api.replace(/\./g, "\\.")}\\s*\\(`, "m");
        if (pattern.test(src)) offenders.push(path.relative(ROOT, file));
      }
      expect(offenders).toEqual([]);
    });
  }
});

describe("fuse builds a fresh result every call", () => {
  // The property `structuredClone` was there to provide. Asserted directly, so
  // replacing the clone with a factory cannot silently reintroduce shared state.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { fuse } = require("../../../shared/geo-core/fusion.ts");

  test("an empty fusion yields empty sections", () => {
    const r = fuse([]);
    expect(r.data.formations).toEqual([]);
    expect(r.data.knownOccurrences).toEqual([]);
  });

  test("what one call pushes does NOT appear in the next", () => {
    // This is the leak the clone prevented. A module-level template mutated in
    // place would accumulate across every call for the life of the process — and
    // on the exploration screen that is a call per timer tick.
    const first = fuse([{
      provider: "geology", category: "spatial", priority: 30, confidence: 0.6,
      data: { formations: [{ name: "Karkaar limestone" }] },
      datasets: [], evidence: [],
    }]);
    expect(first.data.formations).toHaveLength(1);

    const second = fuse([]);
    expect(second.data.formations).toEqual([]);
    expect(second.data.formations).not.toBe(first.data.formations);
  });

  test("nested array sections are fresh too, not shared with the template", () => {
    const a = fuse([]);
    const b = fuse([]);
    expect(a.data.geochemistry.anomalies).not.toBe(b.data.geochemistry.anomalies);
    expect(a.data.geophysics.anomalies).not.toBe(b.data.geophysics.anomalies);
    expect(a.data.remoteSensing.alteration).not.toBe(b.data.remoteSensing.alteration);
  });
});

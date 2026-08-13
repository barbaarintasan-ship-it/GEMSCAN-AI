// A `geo` function must be called through a `geo` client.
//
//   deno test --allow-read supabase/functions/_shared/schemaParity.test.ts
//
// THIS MISTAKE WAS MADE THREE TIMES, and cost a working day between them:
//
//   claim_mission           r2-presign  → POST /rpc/claim_mission 404, twice a
//                           minute. No presigned URL was ever issued, so no
//                           photograph ever reached R2 while the screen read
//                           "UPLOADING 7".
//
//   upsert_mission_package  expeditions → the same 404, and this one was worse
//                           because it was invisible: the other four RPCs in the
//                           same switch are `enterprise.*` and succeeded, so the
//                           app said "all field records filed" while
//                           geo.mission_package stayed empty. Every finished
//                           section reported "no package for mission".
//
// The cause each time is one line of shared plumbing:
//
//   export function serviceClient(schema: string = ENTERPRISE_SCHEMA)
//
// `enterprise` is the right default — most of this codebase is enterprise — and
// the wrong one for `geo`, and nothing at the call site shows which you got.
// TypeScript cannot see it: `rpc()` takes a string, and PostgREST resolves the
// schema at run time.
//
// THE RULE THIS ENFORCES. A `geo` RPC is called on `serviceClient("geo")` in the
// same expression, never through a variable holding a default-schema client. The
// convention is a little verbose, and it is the only form that is checkable.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/** Decoded, and with the Windows leading slash removed: this repo lives under a
 *  path with a space in it, and an undecoded %20 reads as a directory that is not
 *  there. */
const ROOT = decodeURIComponent(new URL("../../..", import.meta.url).pathname)
  .replace(/^\/([A-Za-z]:)/, "$1").replace(/\/$/, "");

async function readAll(dir: string, match: RegExp): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = [];
  for await (const e of Deno.readDir(dir)) {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory) out.push(...await readAll(path, match));
    else if (match.test(e.name)) out.push([path, await Deno.readTextFile(path)]);
  }
  return out;
}

/** Every function name the migrations create in each schema. */
async function functionsBySchema(): Promise<{ geo: Set<string>; enterprise: Set<string> }> {
  const geo = new Set<string>();
  const enterprise = new Set<string>();
  for (const [, sql] of await readAll(`${ROOT}/supabase/migrations`, /\.sql$/)) {
    for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(geo|enterprise)\.(\w+)\s*\(/gi)) {
      (m[1].toLowerCase() === "geo" ? geo : enterprise).add(m[2].toLowerCase());
    }
  }
  return { geo, enterprise };
}


/** The one rule, named once, so the scan and the case below cannot drift apart. */
export function callsThroughGeoClient(statement: string): boolean {
  return /serviceClient\(\s*["']geo["']\s*\)/.test(statement);
}

Deno.test("the migrations really do define functions in both schemas", async () => {
  // If this ever reads zero the scan below is vacuously green and proves nothing.
  const { geo, enterprise } = await functionsBySchema();
  assertEquals(geo.size > 0, true, "no geo.* functions found — the parser is broken");
  assertEquals(enterprise.size > 0, true, "no enterprise.* functions found");
  assertEquals(geo.has("claim_mission"), true);
  assertEquals(geo.has("upsert_mission_package"), true);
});

Deno.test("every geo RPC is called on serviceClient(\"geo\")", async () => {
  const { geo, enterprise } = await functionsBySchema();
  // A name defined in both schemas cannot be judged from the call site alone;
  // there are none today, and if one appears this says so rather than guessing.
  const ambiguous = [...geo].filter((n) => enterprise.has(n));
  assertEquals(ambiguous, [], `defined in both schemas, cannot be checked: ${ambiguous}`);

  const offences: string[] = [];
  for (const [path, src] of await readAll(`${ROOT}/supabase/functions`, /\.ts$/)) {
    if (/\.test\.ts$/.test(path)) continue;
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/(\w+|\))\s*\.rpc\(\s*["'](\w+)["']/g)) {
        const name = m[2].toLowerCase();
        if (!geo.has(name)) continue;
        // The whole statement, because the call is often wrapped over two lines.
        const stmt = lines.slice(Math.max(0, i - 2), i + 1).join(" ");
        if (!callsThroughGeoClient(stmt)) {
          offences.push(`${path.split("/supabase/")[1]}:${i + 1} — ${name}`);
        }
      }
    });
  }
  assertEquals(
    offences, [],
    "a geo.* RPC called without serviceClient(\"geo\") resolves against " +
    "`enterprise` and returns HTTP 404:\n  " + offences.join("\n  "),
  );
});

Deno.test("the two that were wrong stay right", async () => {
  // Named explicitly, because a regex passing over an empty set would also be
  // green. These are the exact call sites that broke the pipeline.
  const presign = await Deno.readTextFile(`${ROOT}/supabase/functions/r2-presign/handler.ts`);
  const expeditions = await Deno.readTextFile(`${ROOT}/supabase/functions/expeditions/handler.ts`);
  assertEquals(/serviceClient\("geo"\)\.rpc\("claim_mission"/.test(presign), true);
  assertEquals(/serviceClient\("geo"\)\.rpc\("upsert_mission_package"/.test(expeditions), true);
});

Deno.test("THE GUARD ACTUALLY CATCHES IT — the exact two shapes that broke", () => {
  // A green scan over correct code proves nothing on its own. These are the lines
  // as they were written when the pipeline was broken, and the rule must reject
  // both: one calling through a variable, one calling the default client inline.
  assertEquals(
    callsThroughGeoClient('const { data } = await svc.rpc("upsert_mission_package", {'),
    false,
  );
  assertEquals(
    callsThroughGeoClient('await serviceClient().rpc("claim_mission", {'),
    false,
  );
  // And accept the fixed form, including the wrapped one.
  assertEquals(
    callsThroughGeoClient('await serviceClient("geo").rpc("claim_mission", {'),
    true,
  );
  assertEquals(
    callsThroughGeoClient('const { data, error } = await serviceClient("geo")   .rpc("save_mission_report", {'),
    true,
  );
});

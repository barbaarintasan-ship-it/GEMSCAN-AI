// Unit tests for the enterprise-samples handler (mocked deps; no DB/stack).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildPayload, type Deps, handleSamples } from "./handler.ts";
import type { Actor } from "../_shared/enterprise/auth.ts";
import { UnauthorizedError, ForbiddenError } from "../_shared/enterprise/errors.ts";

const OWNER: Actor = { userId: "owner-1", email: "awmusse.musse@gmail.com", contributorId: "c1", role: "admin" };
function base(over: Partial<Deps> = {}): Deps {
  return {
    resolveActor: async () => OWNER,
    requireEnterprise: async () => {},
    createSample: async (_a, p) => ({ sample_id: "s1", area_id: "a1", media_count: (p.media as unknown[]).length, sample: { id: "s1" } }),
    listSamples: async () => [{ id: "s1" }, { id: "s2" }],
    getSample: async (_r, _a, id) => (id === "s1" ? { id: "s1", sample_media: [] } : null),
    ...over,
  };
}
function req(method: string, body?: unknown, path = "https://x/enterprise-samples") {
  return new Request(path, { method, body: body ? JSON.stringify(body) : undefined, headers: { "content-type": "application/json" } });
}
const GOOD = {
  name: "Milxa Quartz Vein 01",
  lat: 2.05, lng: 45.32, collected_at: "2026-07-27T10:00:00Z",
  media: [
    { role: "context", storage_path: "u/e/ctx.jpg" },
    { role: "surface_closeup", storage_path: "u/e/close.jpg" },
  ],
  observations: { rock: { rock_class: "granite" }, minerals: [{ mineral: "quartz" }] },
};
const rejects = (body: unknown) => {
  let threw = false;
  try { buildPayload(body as Record<string, unknown>); } catch { threw = true; }
  assert(threw);
};

Deno.test("buildPayload validates + computes h3", () => {
  const p = buildPayload(GOOD);
  assertEquals(p.lat, 2.05);
  assertEquals(p.name, "Milxa Quartz Vein 01");
  assert(typeof p.h3_cell === "string" && (p.h3_cell as string).length > 0);
});
Deno.test("buildPayload enforces every required field (§4/§15)", () => {
  rejects({ ...GOOD, name: "   " });                                   // no name
  rejects({ ...GOOD, lat: undefined });                               // no gps
  rejects({ ...GOOD, lat: 999 });                                     // gps out of range
  rejects({ ...GOOD, collected_at: undefined });                      // no date
  rejects({ ...GOOD, media: [{ role: "surface_closeup", storage_path: "x" }] }); // no context photo
  rejects({ ...GOOD, media: [{ role: "context", storage_path: "x" }] });          // no close-up
  rejects({ ...GOOD, media: [{ role: "bogus", storage_path: "x" }] });            // bad role
});
Deno.test("buildPayload accepts a sample with NO geology (AI-first)", () => {
  const p = buildPayload({ ...GOOD, observations: {} });
  assertEquals(p.name, "Milxa Quartz Vein 01");
  // geology omitted is fine — required set is just name + GPS + date + photos
});

Deno.test("POST valid -> 201 and calls createSample", async () => {
  let called = false;
  const r = await handleSamples(req("POST", GOOD), base({ createSample: async (_a, p) => { called = true; return { sample_id: "s1", media_count: (p.media as unknown[]).length }; } }));
  assertEquals(r.status, 201); assert(called);
  const b = await r.json(); assertEquals(b.sample_id, "s1"); assertEquals(b.media_count, 2);
});
Deno.test("POST missing lat/lng -> 400", async () => {
  const r = await handleSamples(req("POST", { media: [] }), base());
  assertEquals(r.status, 400); assertEquals((await r.json()).code, "bad_request");
});
Deno.test("POST bad JWT -> 401", async () => {
  const r = await handleSamples(req("POST", GOOD), base({ resolveActor: async () => { throw new UnauthorizedError(); } }));
  assertEquals(r.status, 401);
});
Deno.test("POST non-enterprise -> 403", async () => {
  const r = await handleSamples(req("POST", GOOD), base({ requireEnterprise: async () => { throw new ForbiddenError(); } }));
  assertEquals(r.status, 403);
});
Deno.test("GET list -> 200 with samples", async () => {
  const r = await handleSamples(req("GET"), base());
  assertEquals(r.status, 200); assertEquals((await r.json()).samples.length, 2);
});
Deno.test("GET :id found -> 200", async () => {
  const r = await handleSamples(req("GET", undefined, "https://x/enterprise-samples/s1"), base());
  assertEquals(r.status, 200); assertEquals((await r.json()).id, "s1");
});
Deno.test("GET :id not found -> 404", async () => {
  const r = await handleSamples(req("GET", undefined, "https://x/enterprise-samples/zzz"), base());
  assertEquals(r.status, 404);
});
Deno.test("OPTIONS -> 200", async () => {
  assertEquals((await handleSamples(req("OPTIONS"), base())).status, 200);
});

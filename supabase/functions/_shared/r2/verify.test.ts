// File verification, with a fake R2.
//
//   deno test --allow-net=deno.land supabase/functions/_shared/r2/verify.test.ts
//
// The rule under test: an upload is not successful because a device said so. Each
// of these cases is a way that claim can be wrong in the field, and each one must
// leave the package waiting rather than analysed.
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  MIN_PHOTO_BYTES, photosInPackage, summariseVerification, verifyObjects,
} from "./verify.ts";

const CONFIG = {
  accountId: "acct123", accessKeyId: "AKIAFAKE",
  secretAccessKey: "not-a-real-secret", bucket: "bucket",
};
const AT = new Date("2026-08-10T00:00:00.000Z");

/** A fake R2 that answers HEAD from a map of key → [status, bytes]. */
function fakeR2(objects: Record<string, [number, number | null]>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    // The key is everything after the bucket segment.
    const key = decodeURIComponent(url.pathname.replace(`/${CONFIG.bucket}/`, ""));
    const found = objects[key];
    const headers = new Headers();
    if (found && found[1] != null) headers.set("content-length", String(found[1]));
    return new Response(null, { status: found ? found[0] : 404, headers });
  }) as typeof fetch;
}

Deno.test("a present object of a plausible size verifies", async () => {
  const results = await verifyObjects(
    CONFIG, ["missions/m/photos/p1.jpg"],
    { fetch: fakeR2({ "missions/m/photos/p1.jpg": [200, 2_400_000] }), at: AT },
  );
  assertEquals(results[0].exists, true);
  assertEquals(results[0].bytes, 2_400_000);
});

Deno.test("a 404 is absence, and is reported as such rather than thrown", async () => {
  const results = await verifyObjects(
    CONFIG, ["missions/m/photos/missing.jpg"], { fetch: fakeR2({}), at: AT },
  );
  assertEquals(results[0].exists, false);
  assertEquals(results[0].status, 404);
});

Deno.test("a 403 is NOT treated as present", async () => {
  // The signature or the key is wrong. The object may well be there and
  // unreadable, which is not the same as verified — and calling it present would
  // let an unreadable object through the gate into an analysis.
  const results = await verifyObjects(
    CONFIG, ["missions/m/photos/p1.jpg"],
    { fetch: fakeR2({ "missions/m/photos/p1.jpg": [403, null] }), at: AT },
  );
  assertEquals(results[0].exists, false);
  assertEquals(results[0].status, 403);
});

Deno.test("an unreachable R2 THROWS — 'cannot tell' must not become 'not there'", async () => {
  // Failing a mission because the network blinked would destroy real work.
  await assertRejects(() => verifyObjects(
    CONFIG, ["missions/m/photos/p1.jpg"],
    { fetch: (() => Promise.reject(new Error("network down"))) as typeof fetch, at: AT },
  ));
});

Deno.test("THE GATE: one missing photograph leaves the package incomplete", async () => {
  const photos = [
    { id: "p1", key: "missions/m/photos/p1.jpg" },
    { id: "p2", key: "missions/m/photos/p2.jpg" },
  ];
  const results = await verifyObjects(CONFIG, photos.map((p) => p.key), {
    fetch: fakeR2({ "missions/m/photos/p1.jpg": [200, 2_000_000] }), at: AT,
  });
  const summary = summariseVerification(photos, results);
  assertEquals(summary.complete, false);
  assertEquals(summary.verified.map((v) => v.id), ["p1"]);
  assertEquals(summary.missing.map((m) => m.id), ["p2"]);
  assertEquals(summary.missing[0].reason, "HTTP 404");
});

Deno.test("a zero-byte object is not a photograph", async () => {
  // R2 stores an empty object happily if a PUT sent no body, and returns 200 for
  // it afterwards. Existence alone is not enough.
  const photos = [{ id: "p1", key: "missions/m/photos/p1.jpg" }];
  const results = await verifyObjects(CONFIG, ["missions/m/photos/p1.jpg"], {
    fetch: fakeR2({ "missions/m/photos/p1.jpg": [200, 0] }), at: AT,
  });
  const summary = summariseVerification(photos, results);
  assertEquals(summary.complete, false);
  assertEquals(summary.missing[0].reason, "0 bytes — too small to be a photograph");
  // And the threshold is not so tight that a real small photo is rejected.
  const ok = summariseVerification(photos, [
    { key: photos[0].key, exists: true, bytes: MIN_PHOTO_BYTES, status: 200 },
  ]);
  assertEquals(ok.complete, true);
});

Deno.test("everything present and plausible makes the package complete", async () => {
  const photos = [
    { id: "p1", key: "missions/m/photos/p1.jpg" },
    { id: "p2", key: "missions/m/photos/p2.jpg" },
  ];
  const results = await verifyObjects(CONFIG, photos.map((p) => p.key), {
    fetch: fakeR2({
      "missions/m/photos/p1.jpg": [200, 2_000_000],
      "missions/m/photos/p2.jpg": [200, 1_500_000],
    }),
    at: AT,
  });
  const summary = summariseVerification(photos, results);
  assertEquals(summary.complete, true);
  assertEquals(summary.missing, []);
});

Deno.test("a package with no photographs is complete — that is a real finding", () => {
  // "I went there and there was nothing to photograph" is information, and it must
  // not wait for ever on files that were never taken.
  assertEquals(summariseVerification([], []).complete, true);
});

Deno.test("keys are RECOMPUTED from the package, never taken from it", () => {
  const photos = photosInPackage({
    missionId: "ms-abc",
    observations: [
      { photos: [{ id: "p1" }, { id: "p2" }] },
      { photos: [] },
      {},
    ],
  });
  // A device that sent a key of its own choosing must not be able to point a row
  // at somebody else's object, so the key is derived here and nowhere else.
  assertEquals(photos, [
    { id: "p1", key: "missions/ms-abc/photos/p1.jpg" },
    { id: "p2", key: "missions/ms-abc/photos/p2.jpg" },
  ]);
});

Deno.test("the verification key follows the content type, or a PNG waits for ever", () => {
  // The bug this pins: presign signed `.png` for a PNG, while this gate looked for
  // `.jpg`. A missing key is reported as "photograph not in storage" — a WAITING
  // state, not an error — so the mission would have sat at section_completed for
  // ever, waiting on a file that was in the bucket the whole time.
  const photos = photosInPackage({
    missionId: "ms-abc",
    observations: [{
      photos: [
        { id: "p1", contentType: "image/png" },
        { id: "p2", contentType: "image/heic" },
        { id: "p3", contentType: "image/jpeg" },
        { id: "p4" }, // written before the field existed — JPEG
      ],
    }],
  });
  assertEquals(photos, [
    { id: "p1", key: "missions/ms-abc/photos/p1.png" },
    { id: "p2", key: "missions/ms-abc/photos/p2.heic" },
    { id: "p3", key: "missions/ms-abc/photos/p3.jpg" },
    { id: "p4", key: "missions/ms-abc/photos/p4.jpg" },
  ]);
});

Deno.test("a PNG that uploaded correctly now verifies, instead of hanging", async () => {
  // End to end through the real summariser: the object exists under the extension
  // the presigner used, and the gate finds it there.
  const photos = photosInPackage({
    missionId: "ms-abc",
    observations: [{ photos: [{ id: "p1", contentType: "image/png" }] }],
  });
  const results = await verifyObjects(CONFIG, photos.map((p) => p.key), {
    fetch: fakeR2({ "missions/ms-abc/photos/p1.png": [200, 4096] }),
    at: AT,
  });
  assertEquals(summariseVerification(photos, results).complete, true);
});

Deno.test("a result that was never checked is missing, not assumed present", () => {
  const summary = summariseVerification(
    [{ id: "p1", key: "missions/m/photos/p1.jpg" }],
    [],
  );
  assertEquals(summary.complete, false);
  assertEquals(summary.missing[0].reason, "not checked");
});

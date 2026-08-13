// r2-presign, driven with fabricated credentials.
//
//   deno test --allow-net=deno.land supabase/functions/r2-presign/handler.test.ts
//
// The signature maths is proved against AWS's published vector in
// _shared/r2/sign.test.ts. This covers the decisions around it: who is allowed to
// write where, what is refused, and what happens when storage is not configured.
// None of it needs real credentials, and the ownership test is the one that
// matters most — the key shape is guessable, so the claim is the only thing
// standing between one geologist's evidence and another's.
import {
  assertEquals, assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extensionFor, handlePresign, isSafeId, MAX_PHOTOS_PER_REQUEST,
  READ_EXPIRES_S, UPLOAD_EXPIRES_S, type PresignDeps,
} from "./handler.ts";
import type { Actor } from "../_shared/enterprise/auth.ts";
import { ForbiddenError } from "../_shared/enterprise/errors.ts";

const ALICE = { userId: "11111111-1111-1111-1111-111111111111" } as Actor;
const BOB = { userId: "22222222-2222-2222-2222-222222222222" } as Actor;
const AT = new Date("2026-08-10T00:00:00.000Z");

const CONFIG = {
  accountId: "acct123", accessKeyId: "AKIAFAKE",
  secretAccessKey: "not-a-real-secret", bucket: "luulscan-field-evidence",
};

function deps(over: Partial<PresignDeps> = {}, owners = new Map<string, string>()): PresignDeps {
  return {
    resolveActor: async () => ALICE,
    requireEnterprise: async () => {},
    // Mirrors geo.claim_mission: first caller wins, permanently.
    claimMission: async (actor, missionId) => {
      const existing = owners.get(missionId);
      if (existing == null) { owners.set(missionId, actor.userId); return true; }
      return existing === actor.userId;
    },
    config: () => ({ config: CONFIG }),
    now: () => AT,
    ...over,
  };
}

function post(path: string, body: unknown): Request {
  return new Request(`https://x.functions.supabase.co/r2-presign${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

Deno.test("an upload URL is minted per photo, PUT, on the mission's own prefix", async () => {
  const res = await handlePresign(
    post("/upload", { missionId: "ms-abc", photos: [{ photoId: "w1" }, { photoId: "w2" }] }),
    deps(),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.method, "PUT");
  assertEquals(body.items.length, 2);
  assertEquals(body.items[0].key, "missions/ms-abc/photos/w1.jpg");
  assertEquals(body.items[0].expiresIn, UPLOAD_EXPIRES_S);
  assertStringIncludes(body.items[0].url, "acct123.r2.cloudflarestorage.com");
  assertStringIncludes(body.items[0].url, "X-Amz-Signature=");
});

Deno.test("READ urls are GET, and expire sooner than uploads", async () => {
  const res = await handlePresign(
    post("/read", { missionId: "ms-abc", photos: [{ photoId: "w1" }] }),
    deps(),
  );
  const body = await res.json();
  assertEquals(body.method, "GET");
  assertEquals(body.items[0].expiresIn, READ_EXPIRES_S);
  // A read URL exposes the photograph itself and is handed to a model on the way,
  // so it is the shorter-lived of the two.
  assertEquals(READ_EXPIRES_S < UPLOAD_EXPIRES_S, true);
});

Deno.test("THE OWNERSHIP GATE: a second user cannot be signed into a claimed mission", async () => {
  const owners = new Map<string, string>();
  const alice = deps({}, owners);
  const bob = deps({ resolveActor: async () => BOB }, owners);

  const first = await handlePresign(post("/upload", { missionId: "ms-abc", photos: [{ photoId: "w1" }] }), alice);
  assertEquals(first.status, 200);

  // Mission ids are ms-{base36}-{seq}, generated offline and guessable. Without
  // this refusal an authenticated stranger could overwrite the evidence.
  const second = await handlePresign(post("/upload", { missionId: "ms-abc", photos: [{ photoId: "w1" }] }), bob);
  assertEquals(second.status, 403);
  assertStringIncludes((await second.json()).error, "another user");
});

Deno.test("the claim is checked BEFORE anything is signed", async () => {
  let signed = false;
  const res = await handlePresign(
    post("/upload", { missionId: "ms-abc", photos: [{ photoId: "w1" }] }),
    deps({
      claimMission: async () => false,
      config: () => { signed = true; return { config: CONFIG }; },
    }),
  );
  assertEquals(res.status, 403);
  // The config read happens first by necessity, but no URL comes back.
  assertEquals(Object.hasOwn(await res.json(), "items"), false);
  assertEquals(signed, true);
});

Deno.test("missing configuration is reported by NAME, and is not an outage", async () => {
  const res = await handlePresign(
    post("/upload", { missionId: "ms-abc", photos: [{ photoId: "w1" }] }),
    deps({ config: () => ({ missing: ["R2_SECRET_ACCESS_KEY"] }) }),
  );
  // 503, not 500: nothing is broken. The secret is absent, the operator can see
  // which one, and the device keeps the photographs on disk meanwhile.
  assertEquals(res.status, 503);
  assertEquals((await res.json()).missing, ["R2_SECRET_ACCESS_KEY"]);
});

Deno.test("unsafe ids are REFUSED, never sanitised", async () => {
  // A silently-rewritten id yields a key the device did not expect and then a
  // database row pointing at an object that is not there.
  for (const bad of ["../../etc/passwd", "a/b", "", "with space", "x".repeat(200), "-leading"]) {
    const res = await handlePresign(
      post("/upload", { missionId: "ms-abc", photos: [{ photoId: bad }] }), deps(),
    );
    assertEquals(res.status, 400, `photoId ${JSON.stringify(bad)} should be refused`);
  }
  const res = await handlePresign(post("/upload", { missionId: "../other", photos: [{ photoId: "w1" }] }), deps());
  assertEquals(res.status, 400);
});

Deno.test("only image types are accepted", async () => {
  const ok = await handlePresign(
    post("/upload", { missionId: "ms-abc", photos: [{ photoId: "w1", contentType: "image/png" }] }),
    deps(),
  );
  assertEquals(ok.status, 200);
  assertEquals((await ok.json()).items[0].key, "missions/ms-abc/photos/w1.png");

  const bad = await handlePresign(
    post("/upload", { missionId: "ms-abc", photos: [{ photoId: "w1", contentType: "application/pdf" }] }),
    deps(),
  );
  assertEquals(bad.status, 400);
});

Deno.test("the extension follows the bytes, so the key never lies about them", () => {
  assertEquals(extensionFor("image/jpeg"), "jpg");
  assertEquals(extensionFor("image/jpg"), "jpg");
  assertEquals(extensionFor("image/png"), "png");
  assertEquals(extensionFor("image/webp"), "webp");
  assertEquals(extensionFor("image/heic"), "heic");
  assertEquals(extensionFor(undefined), "jpg");
  // Uppercase and junk both resolve, rather than producing a key with a
  // capitalised or nonsense extension that nothing downstream would look for.
  assertEquals(extensionFor("IMAGE/PNG"), "png");
  assertEquals(extensionFor("nonsense"), "jpg");
});

Deno.test("THE ENTITLEMENT GATE: a non-enterprise account gets no upload URL", async () => {
  // This endpoint was the one unguarded door into object storage. `expeditions`
  // refuses the package that gives these bytes meaning, so without the same gate
  // here an ungated account could fill payable storage with objects no row would
  // ever reference and nothing would ever read.
  let signed = false;
  const res = await handlePresign(
    post("/upload", { missionId: "ms-abc", photos: [{ photoId: "w1" }] }),
    deps({
      requireEnterprise: async () => { throw new ForbiddenError("enterprise access is not enabled"); },
      config: () => { signed = true; return { config: CONFIG }; },
    }),
  );
  assertEquals(res.status, 403);
  assertEquals(Object.hasOwn(await res.json(), "items"), false);
  // Refused before the configuration was even read, let alone anything signed.
  assertEquals(signed, false);
});

Deno.test("the gate runs on READ as well as upload", async () => {
  // A read URL is the more sensitive of the two: it exposes the photograph.
  const res = await handlePresign(
    post("/read", { missionId: "ms-abc", photos: [{ photoId: "w1" }] }),
    deps({ requireEnterprise: async () => { throw new ForbiddenError("nope"); } }),
  );
  assertEquals(res.status, 403);
});

Deno.test("storage configuration is not disclosed before the caller is authorised", async () => {
  // Previously the 503 naming the absent secrets was returned before any
  // authentication ran, so an unauthorised caller could learn whether the
  // operator had configured their storage. Free to close now there is a gate.
  const res = await handlePresign(
    post("/upload", { missionId: "ms-abc", photos: [{ photoId: "w1" }] }),
    deps({
      requireEnterprise: async () => { throw new ForbiddenError("nope"); },
      config: () => ({ missing: ["R2_SECRET_ACCESS_KEY"] }),
    }),
  );
  assertEquals(res.status, 403);
  assertEquals(Object.hasOwn(await res.json(), "missing"), false);
});

Deno.test("a request must carry photos, and not too many", async () => {
  assertEquals((await handlePresign(post("/upload", { missionId: "ms-abc", photos: [] }), deps())).status, 400);
  assertEquals((await handlePresign(post("/upload", { missionId: "ms-abc" }), deps())).status, 400);
  const many = Array.from({ length: MAX_PHOTOS_PER_REQUEST + 1 }, (_, i) => ({ photoId: `w${i}` }));
  assertEquals((await handlePresign(post("/upload", { missionId: "ms-abc", photos: many }), deps())).status, 400);
});

Deno.test("GET and OPTIONS are handled without signing anything", async () => {
  const opts = await handlePresign(
    new Request("https://x/r2-presign/upload", { method: "OPTIONS" }), deps(),
  );
  assertEquals(opts.status, 200);
  const get = await handlePresign(
    new Request("https://x/r2-presign/upload", { method: "GET" }), deps(),
  );
  assertEquals(get.status, 400);
});

Deno.test("id safety rules, directly", () => {
  assertEquals(isSafeId("ms-abc-1"), true);
  assertEquals(isSafeId("w1_2-3"), true);
  assertEquals(isSafeId("a/b"), false);
  assertEquals(isSafeId(".."), false);
  assertEquals(isSafeId(""), false);
});

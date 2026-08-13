// SigV4, checked against the example AWS publishes.
//
//   deno test --allow-none supabase/functions/_shared/r2/sign.test.ts
//
// This is the one part of the storage layer whose correctness can be established
// with no credentials and no network: AWS documents a worked presigned-URL
// example with a fixed key, date and expected signature, so a wrong
// implementation fails here rather than in the field with
// "SignatureDoesNotMatch" and nothing else to go on.
//
// If this test ever fails, the implementation is wrong. The expected value is not
// to be adjusted to match it.
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  amzDates, missionPrefix, photoKey, presignR2Url, presignS3Url, r2ConfigFromEnv, uriEncode,
} from "./sign.ts";

// AWS "Signature Calculation for Presigned URL" worked example.
const AWS_EXAMPLE = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  host: "examplebucket.s3.amazonaws.com",
  region: "us-east-1",
  canonicalUri: "/test.txt",
  at: new Date("2013-05-24T00:00:00.000Z"),
  expiresIn: 86400,
  signature: "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
};

Deno.test("the published AWS example signs byte for byte", async () => {
  const url = await presignS3Url({
    accessKeyId: AWS_EXAMPLE.accessKeyId,
    secretAccessKey: AWS_EXAMPLE.secretAccessKey,
    host: AWS_EXAMPLE.host,
    region: AWS_EXAMPLE.region,
    canonicalUri: AWS_EXAMPLE.canonicalUri,
    method: "GET",
    expiresIn: AWS_EXAMPLE.expiresIn,
    at: AWS_EXAMPLE.at,
  });
  assertEquals(new URL(url).searchParams.get("X-Amz-Signature"), AWS_EXAMPLE.signature);
});

Deno.test("the signed parameters are the ones the algorithm requires", async () => {
  const url = await presignS3Url({
    ...AWS_EXAMPLE, method: "GET", expiresIn: 900, at: AWS_EXAMPLE.at,
  });
  const q = new URL(url).searchParams;
  assertEquals(q.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assertEquals(q.get("X-Amz-SignedHeaders"), "host");
  assertEquals(q.get("X-Amz-Date"), "20130524T000000Z");
  assertEquals(q.get("X-Amz-Expires"), "900");
  assertEquals(
    q.get("X-Amz-Credential"),
    "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request",
  );
});

Deno.test("uriEncode escapes what encodeURIComponent leaves alone", () => {
  // These five are the whole reason this function exists. encodeURIComponent
  // passes them through, SigV4 requires them encoded, and the resulting mismatch
  // reports itself only as an unexplained signature failure.
  assertEquals(uriEncode("!'()*"), "%21%27%28%29%2A");
  assertEquals(uriEncode("a b"), "a%20b");
  assertEquals(uriEncode("a/b"), "a%2Fb");
  assertEquals(uriEncode("a/b", false), "a/b");
  // Unreserved characters must survive untouched.
  assertEquals(uriEncode("Az09-_.~"), "Az09-_.~");
  // Multi-byte input is encoded per UTF-8 byte, not per character.
  assertEquals(uriEncode("é"), "%C3%A9");
});

Deno.test("amz dates are the two forms SigV4 wants", () => {
  const { amzDate, dateStamp } = amzDates(new Date("2026-08-10T09:15:30.123Z"));
  assertEquals(amzDate, "20260810T091530Z");
  assertEquals(dateStamp, "20260810");
});

Deno.test("R2 URLs are path style, on the account endpoint", async () => {
  const url = await presignR2Url({
    config: {
      accountId: "acct123", accessKeyId: "AKIA", secretAccessKey: "SECRET",
      bucket: "luulscan-field-evidence",
    },
    key: photoKey("ms-abc", "w1"),
    method: "PUT",
    expiresIn: 300,
    at: new Date("2026-08-10T00:00:00.000Z"),
  });
  assertStringIncludes(url, "https://acct123.r2.cloudflarestorage.com/");
  // Bucket in the path, not the host: R2 does not serve virtual-hosted buckets here.
  assertStringIncludes(url, "/luulscan-field-evidence/missions/ms-abc/photos/w1.jpg?");
  // Slashes in a key stay slashes, or the object lands at a different path than
  // the database recorded.
  assertEquals(url.includes("%2Fmissions"), false);
  assertEquals(new URL(url).searchParams.get("X-Amz-Expires"), "300");
});

Deno.test("the same request signs identically every time", async () => {
  const config = {
    accountId: "acct123", accessKeyId: "AKIA", secretAccessKey: "SECRET", bucket: "b",
  };
  const at = new Date("2026-08-10T00:00:00.000Z");
  const a = await presignR2Url({ config, key: "missions/m/photos/p.jpg", method: "PUT", expiresIn: 300, at });
  const b = await presignR2Url({ config, key: "missions/m/photos/p.jpg", method: "PUT", expiresIn: 300, at });
  assertEquals(a, b);
});

Deno.test("changing anything at all changes the signature", async () => {
  const config = {
    accountId: "acct123", accessKeyId: "AKIA", secretAccessKey: "SECRET", bucket: "b",
  };
  const at = new Date("2026-08-10T00:00:00.000Z");
  const base = { config, key: "missions/m/photos/p.jpg", method: "PUT" as const, expiresIn: 300, at };
  const sig = (u: string) => new URL(u).searchParams.get("X-Amz-Signature");

  const original = sig(await presignR2Url(base));
  // A URL minted for PUT must not also authorise GET, or a leaked upload link
  // becomes a read of every photograph whose key can be guessed.
  assertEquals(sig(await presignR2Url({ ...base, method: "GET" })) === original, false);
  assertEquals(sig(await presignR2Url({ ...base, key: "missions/m/photos/q.jpg" })) === original, false);
  assertEquals(sig(await presignR2Url({ ...base, expiresIn: 301 })) === original, false);
});

Deno.test("missing configuration is NAMED, not guessed at", () => {
  const env = (k: string) => ({ R2_ACCOUNT_ID: "a", R2_BUCKET_NAME: "b" } as Record<string, string>)[k];
  const result = r2ConfigFromEnv(env);
  // The caller can tell the operator exactly which secrets are absent, rather
  // than failing with a signature error against an empty key.
  assertEquals("missing" in result, true);
  assertEquals(
    (result as { missing: string[] }).missing,
    ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"],
  );
});

Deno.test("configuration is read whole when it is all present", () => {
  const values: Record<string, string> = {
    R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "id",
    R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET_NAME: "bucket",
  };
  const result = r2ConfigFromEnv((k) => values[k]);
  assertEquals("config" in result, true);
  assertEquals((result as { config: { bucket: string } }).config.bucket, "bucket");
});

Deno.test("keys have ONE shape, so nothing can disagree about where a file is", () => {
  assertEquals(photoKey("ms-abc", "w1"), "missions/ms-abc/photos/w1.jpg");
  assertEquals(photoKey("ms-abc", "w1", "png"), "missions/ms-abc/photos/w1.png");
  assertEquals(missionPrefix("ms-abc"), "missions/ms-abc/");
  // Everything for a mission sits under its prefix, so archiving or deleting one
  // is a single prefix operation rather than a list of files to remember.
  assertStringIncludes(photoKey("ms-abc", "w1"), missionPrefix("ms-abc"));
});

// ── R2_ENDPOINT, which is configured alongside R2_ACCOUNT_ID ─────────────────
//
// Both describe the same host, so both being set is two sources of truth for one
// value. These cover the three outcomes: the explicit host is used, a mismatch is
// named, and nonsense is named.
Deno.test("an explicit R2_ENDPOINT is used for signing", async () => {
  const values: Record<string, string> = {
    R2_ACCOUNT_ID: "acct123", R2_ACCESS_KEY_ID: "id",
    R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET_NAME: "bucket",
    R2_ENDPOINT: "https://acct123.r2.cloudflarestorage.com",
  };
  const result = r2ConfigFromEnv((k) => values[k]);
  assertEquals("config" in result, true);
  const config = (result as { config: { host?: string } }).config;
  assertEquals(config.host, "acct123.r2.cloudflarestorage.com");

  const url = await presignR2Url({
    config: config as Parameters<typeof presignR2Url>[0]["config"],
    key: "missions/m/photos/p.jpg", method: "PUT", expiresIn: 300,
    at: new Date("2026-08-10T00:00:00.000Z"),
  });
  assertStringIncludes(url, "https://acct123.r2.cloudflarestorage.com/bucket/");
});

Deno.test("an endpoint that does not match the account id is REFUSED", () => {
  // Signing against the wrong host fails with nothing but
  // "SignatureDoesNotMatch" on every single upload. Naming it here is the
  // difference between a one-line fix and an afternoon.
  const values: Record<string, string> = {
    R2_ACCOUNT_ID: "acct123", R2_ACCESS_KEY_ID: "id",
    R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET_NAME: "bucket",
    R2_ENDPOINT: "https://someoneelse.r2.cloudflarestorage.com",
  };
  const result = r2ConfigFromEnv((k) => values[k]);
  assertEquals("conflict" in result, true);
  assertStringIncludes((result as { conflict: string }).conflict, "does not belong to R2_ACCOUNT_ID");
});

Deno.test("an endpoint with no scheme is still understood", () => {
  const values: Record<string, string> = {
    R2_ACCOUNT_ID: "acct123", R2_ACCESS_KEY_ID: "id",
    R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET_NAME: "bucket",
    R2_ENDPOINT: "acct123.r2.cloudflarestorage.com",
  };
  const result = r2ConfigFromEnv((k) => values[k]);
  assertEquals("config" in result, true);
  assertEquals((result as { config: { host?: string } }).config.host, "acct123.r2.cloudflarestorage.com");
});

Deno.test("no endpoint at all derives the host from the account", async () => {
  const values: Record<string, string> = {
    R2_ACCOUNT_ID: "acct123", R2_ACCESS_KEY_ID: "id",
    R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET_NAME: "bucket",
  };
  const result = r2ConfigFromEnv((k) => values[k]);
  const config = (result as { config: { host?: string } }).config;
  assertEquals(config.host, undefined);
  const url = await presignR2Url({
    config: config as Parameters<typeof presignR2Url>[0]["config"],
    key: "k", method: "PUT", expiresIn: 300, at: new Date("2026-08-10T00:00:00.000Z"),
  });
  assertStringIncludes(url, "https://acct123.r2.cloudflarestorage.com/");
});

Deno.test("R2 URLs match @aws-sdk/s3-request-presigner BYTE FOR BYTE", async () => {
  // THE BUG THIS EXISTS FOR.
  //
  // `X-Amz-Content-Sha256=UNSIGNED-PAYLOAD` was missing from the query string.
  // AWS's own worked example omits it and S3 accepts a URL without it, so nothing
  // in the AWS vector above caught it — but every AWS SDK emits it, and R2 signs
  // against what the SDKs produce.
  //
  // The parameter is part of the canonical query string, so leaving it out yields
  // a different, perfectly well-formed signature, and R2 answers a bare 403 that
  // looks exactly like wrong credentials, a wrong bucket and a wrong account. No
  // photograph ever reached storage; `evidence_photo` stayed empty and
  // `remotePath` was never written, and both read as unfinished features.
  //
  // The expected URL below was generated by @aws-sdk/s3-request-presigner with
  // forcePathStyle against the R2 endpoint, for these exact inputs. If this test
  // fails, the URL this project signs no longer matches the reference — and R2
  // will refuse it without saying why.
  const url = await presignR2Url({
    config: {
      accountId: "c4b8ea0b59b0dff0c54b89f068e3abdf",
      accessKeyId: "AKIAFAKE0000000000000000000000AA",
      secretAccessKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      bucket: "luulscan-field-data",
    },
    key: "missions/__healthcheck__/photos/probe.jpg",
    method: "HEAD",
    expiresIn: 60,
    at: new Date("2026-08-11T00:00:00Z"),
  });

  const q = new URL(url).searchParams;
  assertEquals(q.get("X-Amz-Content-Sha256"), "UNSIGNED-PAYLOAD");
  assertEquals(
    q.get("X-Amz-Signature"),
    "d7006190fffbbd2104ac152b553186cc431427ed5f3b3c66e0029eef2205837d",
  );
});

Deno.test("the generic S3 signer stays faithful to the AWS example", async () => {
  // The payload-hash parameter is added by presignR2Url, NOT by presignS3Url —
  // otherwise the published AWS vector at the top of this file would no longer
  // reproduce. R2's strictness is R2's, and it does not belong in the generic
  // signer.
  const url = await presignS3Url({
    accessKeyId: "AKID", secretAccessKey: "SECRET",
    host: "example.s3.amazonaws.com", region: "us-east-1",
    canonicalUri: "/x.txt", method: "GET", expiresIn: 60,
    at: new Date("2026-08-11T00:00:00Z"),
  });
  assertEquals(new URL(url).searchParams.get("X-Amz-Content-Sha256"), null);
});

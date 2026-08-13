// AWS Signature Version 4, for Cloudflare R2.
//
// R2 speaks the S3 API, so a presigned URL is an ordinary SigV4 query-string
// signature with region "auto". Written here rather than pulled from an SDK
// because the whole job is four HMACs and a canonical string, and an edge
// function that imports an AWS SDK to build one URL pays for it on every cold
// start.
//
// WHY PRESIGNED URLS AT ALL
//
// The R2 secret must never leave the server. A phone that could sign its own
// requests would have to carry the key, and a key in an APK is extractable in
// minutes — field evidence is private data with coordinates in it. So the device
// asks for a URL that is good for one object, one method and a few minutes, and
// uploads straight to R2 without the bytes ever passing through Supabase.
//
// Correctness here is checkable without credentials: sigv4.test.ts runs the
// canonical example published in the AWS documentation and compares the
// signature byte for byte.

const ALGORITHM = "AWS4-HMAC-SHA256";
/** R2 has no regions. The signature still needs one, and "auto" is what it wants. */
export const R2_REGION = "auto";
const SERVICE = "s3";

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /**
   * The endpoint host, when it was configured explicitly.
   *
   * `R2_ENDPOINT` and `R2_ACCOUNT_ID` describe the same thing, so both being set
   * is two sources of truth for one value. Rather than pick one silently, the
   * explicit host wins and a mismatch is REPORTED — a signature computed against
   * the wrong host fails with nothing but "SignatureDoesNotMatch", which is about
   * the least diagnosable error in the whole protocol.
   */
  host?: string;
}

/**
 * Read the configuration from the environment, or say exactly what is missing.
 *
 * Returns null rather than throwing so a caller can answer "storage is not
 * configured" with a clear message instead of a stack trace — and so the rest of
 * the app keeps working with photos held on the device, which is a legitimate
 * state and the one the field is usually in anyway.
 */
export function r2ConfigFromEnv(
  env: (k: string) => string | undefined,
): { config: R2Config } | { missing: string[] } | { conflict: string } {
  const keys = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"];
  const missing = keys.filter((k) => !env(k));
  if (missing.length > 0) return { missing };

  const accountId = env("R2_ACCOUNT_ID")!;
  const endpoint = env("R2_ENDPOINT");
  let host: string | undefined;
  if (endpoint) {
    try {
      host = new URL(endpoint.includes("://") ? endpoint : `https://${endpoint}`).host;
    } catch {
      return { conflict: `R2_ENDPOINT is not a URL: ${endpoint}` };
    }
    // Both were set and they disagree. Signing against the wrong host would fail
    // with an unexplained signature error on every upload, so it is named here
    // instead.
    if (!host.startsWith(accountId + ".")) {
      return {
        conflict:
          `R2_ENDPOINT host "${host}" does not belong to R2_ACCOUNT_ID — ` +
          `one of the two is wrong`,
      };
    }
  }

  return {
    config: {
      accountId,
      accessKeyId: env("R2_ACCESS_KEY_ID")!,
      secretAccessKey: env("R2_SECRET_ACCESS_KEY")!,
      bucket: env("R2_BUCKET_NAME")!,
      host,
    },
  };
}

export function r2Endpoint(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

async function hmac(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    "raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return crypto.subtle.sign("HMAC", k, enc.encode(msg));
}

/**
 * Percent-encode for a canonical URI or query string.
 *
 * NOT `encodeURIComponent`: that leaves `!'()*` alone, and SigV4 requires them
 * encoded. A single wrong byte here produces a signature that verifies nowhere,
 * with an error message that says only "SignatureDoesNotMatch".
 */
export function uriEncode(s: string, encodeSlash = true): string {
  let out = "";
  for (const ch of s) {
    const isUnreserved =
      (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") ||
      ch === "-" || ch === "_" || ch === "." || ch === "~";
    if (isUnreserved) out += ch;
    else if (ch === "/") out += encodeSlash ? "%2F" : "/";
    else {
      for (const b of enc.encode(ch)) out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

/** `20260810T091530Z` and `20260810`, the two forms every part of SigV4 wants. */
export function amzDates(at: Date): { amzDate: string; dateStamp: string } {
  const amzDate = at.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

async function signingKey(
  secret: string, dateStamp: string, region: string, service: string,
): Promise<ArrayBuffer> {
  const kDate = await hmac(enc.encode("AWS4" + secret), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

/** The parts of a presigned URL that are not R2-specific. Exposed so the AWS
 * published test vector can drive the exact same code path the product uses. */
export interface SignInput {
  accessKeyId: string;
  secretAccessKey: string;
  host: string;
  region: string;
  /** Already-encoded path, beginning with a slash. */
  canonicalUri: string;
  method: "PUT" | "GET" | "DELETE" | "HEAD";
  expiresIn: number;
  at: Date;
  query?: Record<string, string>;
}

/**
 * SigV4 query-string signing, in the general form.
 *
 * Only the host is signed (`SignedHeaders=host`), which is what lets the device
 * PUT with no extra headers — `FileSystem.uploadAsync` sends a few of its own, and
 * signing them would mean uploads failing for a reason invisible from the server.
 */
export async function presignS3Url(input: SignInput): Promise<string> {
  const { accessKeyId, secretAccessKey, host, region, canonicalUri, method, expiresIn, at } = input;
  const { amzDate, dateStamp } = amzDates(at);
  const credential = `${accessKeyId}/${dateStamp}/${region}/${SERVICE}/aws4_request`;

  const params: Record<string, string> = {
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": credential,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": "host",
    ...(input.query ?? {}),
  };
  // Canonical query strings sort by encoded key, then encoded value.
  const canonicalQuery = Object.keys(params)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(params[k])}`)
    .join("&");

  // UNSIGNED-PAYLOAD: the body is not known when the URL is minted, and for a
  // presigned upload it never is — that is the whole point of handing the device a
  // URL instead of the bytes.
  const canonicalRequest = [
    method, canonicalUri, canonicalQuery, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD",
  ].join("\n");

  const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
  const signature = hex(await hmac(
    await signingKey(secretAccessKey, dateStamp, region, SERVICE), stringToSign,
  ));

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export interface PresignInput {
  config: R2Config;
  /** Object key, e.g. `missions/ms-abc/photos/w1.jpg`. Slashes stay slashes. */
  key: string;
  method: "PUT" | "GET" | "DELETE" | "HEAD";
  expiresIn: number;
  at?: Date;
  /** Extra signed query parameters, e.g. a response content type. */
  query?: Record<string, string>;
}

/**
 * R2 wants the payload hash as a QUERY PARAMETER, not only in the canonical
 * request.
 *
 * AWS's own presigned-URL worked example omits it, and S3 accepts a URL without
 * it — so `presignS3Url` stays faithful to that example and this is added here,
 * for R2 only. Every AWS SDK emits it, which is the tell: R2 is signed against
 * what the SDK produces, not against the minimum the specification allows.
 *
 * Leaving it out cost this project a working upload path. The parameter is part
 * of the canonical query string, so omitting it produces a DIFFERENT, perfectly
 * well-formed signature — and R2 answers a bare 403 that is indistinguishable
 * from wrong credentials, a wrong bucket and a wrong account. Nothing had ever
 * reached storage; `evidence_photo` was empty and `remotePath` was never written,
 * and both looked like features that had simply not been wired up yet.
 *
 * Verified byte-for-byte against `@aws-sdk/s3-request-presigner` for identical
 * inputs. `sign.test.ts` pins that comparison.
 */
const R2_PAYLOAD_HASH = "UNSIGNED-PAYLOAD";

/** A URL good for exactly one object, one method and `expiresIn` seconds. */
export function presignR2Url(input: PresignInput): Promise<string> {
  const { config } = input;
  return presignS3Url({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    // The configured host when there is one, otherwise derived from the account.
    host: config.host ?? `${config.accountId}.r2.cloudflarestorage.com`,
    region: R2_REGION,
    // Path style: R2 does not do virtual-hosted buckets on this endpoint.
    canonicalUri: "/" + uriEncode(config.bucket, false) + "/" + uriEncode(input.key, false),
    method: input.method,
    expiresIn: input.expiresIn,
    at: input.at ?? new Date(),
    query: { "X-Amz-Content-Sha256": R2_PAYLOAD_HASH, ...input.query },
  });
}

/** Field evidence is photographs. Anything else is refused rather than stored. */
export const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic",
]);

/**
 * `jpg` for jpeg, otherwise the subtype — so the key's extension matches the bytes.
 *
 * Lives here, beside `photoKey`, because the extension and the key are one
 * decision. It used to live in the presign handler alone, which meant the signer
 * derived `.png` from a PNG upload while the database row and the verification
 * pass both assumed `.jpg` — see `photoKeyFor`.
 */
export function extensionFor(contentType: string | undefined): string {
  const t = (contentType ?? "image/jpeg").toLowerCase();
  if (t === "image/jpeg" || t === "image/jpg") return "jpg";
  const sub = t.split("/")[1];
  return sub && /^[a-z0-9]+$/.test(sub) ? sub : "jpg";
}

/**
 * The canonical key for a mission photograph.
 *
 * One shape, defined once, so the device, the database and the analysis cannot
 * disagree about where a file is. A record whose key is computed in three places
 * is a record that eventually points at nothing.
 *
 * That is not a hypothetical: it happened. `r2-presign` signed the extension the
 * content type implied, while `upsert_mission_package` and `photosInPackage` both
 * hardcoded `.jpg`. A single PNG would have been uploaded to a key nothing else
 * could name — and because the verification gate reports "photograph not in
 * storage" rather than an error, the mission would have waited for a file that
 * was already there, silently, for ever. Prefer `photoKeyFor` at call sites that
 * hold a content type.
 */
export function photoKey(missionId: string, photoId: string, ext = "jpg"): string {
  return `missions/${missionId}/photos/${photoId}.${ext}`;
}

/** `photoKey`, derived from the content type rather than a caller's guess. */
export function photoKeyFor(
  missionId: string,
  photoId: string,
  contentType: string | undefined,
): string {
  return photoKey(missionId, photoId, extensionFor(contentType));
}

/** Everything belonging to one mission, for archival or deletion. */
export function missionPrefix(missionId: string): string {
  return `missions/${missionId}/`;
}

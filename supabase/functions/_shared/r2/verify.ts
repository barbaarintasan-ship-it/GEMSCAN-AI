// Did the bytes actually arrive?
//
// A device reporting "uploaded" is a claim, not a fact. The claim can be wrong in
// ordinary ways — a presigned URL that expired mid-transfer and returned 403, a
// process killed after the state was written but before the PUT completed, a
// proxy that swallowed the body — and every one of those produces a mission whose
// database rows point at objects that are not there.
//
// So before anything is analysed, each key is HEADed against R2 and the result is
// what decides. An assessment written from a partial evidence set is worse than no
// assessment: it reads exactly like a complete one.
//
// HEAD, not GET: the answer needed is existence and size, and pulling several
// megabytes of photograph through an edge function to learn that would cost
// bandwidth for nothing.
import { photoKeyFor, presignR2Url, type R2Config } from "./sign.ts";

/** Long enough for one HEAD. It never leaves the server. */
const HEAD_EXPIRES_S = 60;

export interface VerifiedObject {
  key: string;
  exists: boolean;
  bytes: number | null;
  /** The HTTP status R2 gave, so a 403 is distinguishable from a 404. */
  status: number;
}

export interface VerifyDeps {
  fetch?: typeof fetch;
  at?: Date;
}

/**
 * HEAD every key. Returns one result per key, in the order given.
 *
 * Never throws for a missing object — absence is the answer being asked for. It
 * does throw if R2 itself is unreachable, because "cannot tell" must not be
 * recorded as "not there": deleting or failing a mission because the network
 * blinked would destroy real work.
 */
export async function verifyObjects(
  config: R2Config,
  keys: readonly string[],
  deps: VerifyDeps = {},
): Promise<VerifiedObject[]> {
  const doFetch = deps.fetch ?? fetch;
  const at = deps.at ?? new Date();
  const out: VerifiedObject[] = [];

  for (const key of keys) {
    const url = await presignR2Url({
      config, key, method: "HEAD", expiresIn: HEAD_EXPIRES_S, at,
    });
    const res = await doFetch(url, { method: "HEAD" });
    const len = res.headers.get("content-length");
    out.push({
      key,
      // 2xx and nothing else. A 403 means the signature or the key is wrong, which
      // is not the same as the object being absent — and treating it as "present"
      // would let an unreadable object through the gate.
      exists: res.status >= 200 && res.status < 300,
      bytes: len == null ? null : Number(len),
      status: res.status,
    });
  }
  return out;
}

/**
 * A zero-byte object is NOT a photograph.
 *
 * R2 will happily store an empty object if a PUT sent no body, and it returns 200
 * for it afterwards. Existence alone therefore is not enough to call a photograph
 * verified.
 */
export const MIN_PHOTO_BYTES = 1024;

export interface VerificationSummary {
  verified: Array<{ id: string; key: string; bytes: number | null }>;
  missing: Array<{ id: string; key: string; status: number; bytes: number | null; reason: string }>;
  complete: boolean;
}

/**
 * Turn HEAD results into the decision: is this package analysable yet?
 *
 * `complete` is true only when every photograph is present and plausibly a
 * photograph. Anything short of that leaves the package waiting rather than being
 * assessed on what happens to have arrived.
 */
export function summariseVerification(
  photos: ReadonlyArray<{ id: string; key: string }>,
  results: readonly VerifiedObject[],
): VerificationSummary {
  const byKey = new Map(results.map((r) => [r.key, r]));
  const verified: VerificationSummary["verified"] = [];
  const missing: VerificationSummary["missing"] = [];

  for (const p of photos) {
    const r = byKey.get(p.key);
    if (!r) {
      missing.push({ id: p.id, key: p.key, status: 0, bytes: null, reason: "not checked" });
    } else if (!r.exists) {
      missing.push({ id: p.id, key: p.key, status: r.status, bytes: r.bytes, reason: `HTTP ${r.status}` });
    } else if (r.bytes != null && r.bytes < MIN_PHOTO_BYTES) {
      missing.push({
        id: p.id, key: p.key, status: r.status, bytes: r.bytes,
        reason: `${r.bytes} bytes — too small to be a photograph`,
      });
    } else {
      verified.push({ id: p.id, key: p.key, bytes: r.bytes });
    }
  }

  return { verified, missing, complete: missing.length === 0 && photos.length === verified.length };
}

/**
 * Every photograph named in a package, with the key it should be at.
 *
 * The key is RECOMPUTED from the package rather than read from it, so a device
 * that sent a key of its own choosing cannot point a row at somebody else's
 * object. That rule stays; what changed is that the extension is now derived from
 * the photograph's content type instead of assumed to be `.jpg`.
 *
 * The assumption was invisible while every field photograph was a JPEG, and would
 * have failed in the worst available way once one was not: this gate reports a
 * key it cannot find as "photograph not in storage", so a PNG that uploaded
 * perfectly would have left its mission waiting for ever on a file that was
 * already there.
 */
export function photosInPackage(
  payload: {
    missionId?: string;
    observations?: Array<{ photos?: Array<{ id?: string; contentType?: string }> }>;
  },
): Array<{ id: string; key: string }> {
  const missionId = payload.missionId ?? "";
  const out: Array<{ id: string; key: string }> = [];
  for (const obs of payload.observations ?? []) {
    for (const photo of obs.photos ?? []) {
      if (!photo.id) continue;
      // Packages written before `contentType` existed carry none, and JPEG is
      // what those photographs actually are — so the old keys still resolve.
      out.push({ id: photo.id, key: photoKeyFor(missionId, photo.id, photo.contentType) });
    }
  }
  return out;
}

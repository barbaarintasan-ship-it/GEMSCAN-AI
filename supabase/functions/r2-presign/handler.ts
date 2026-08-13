// r2-presign — the only way a device gets to write to object storage.
//
//   POST /r2-presign/upload   URLs to PUT a mission's photographs
//   POST /r2-presign/read     URLs to GET them back, for the app and the analysis
//
// WHY AN ENDPOINT AND NOT A KEY IN THE APP
// ---------------------------------------
// The R2 secret signs anything in the bucket. A phone holding it could read every
// geologist's evidence, and a key inside an APK is extractable in minutes. So the
// secret stays on the server and the device is handed URLs that are good for one
// object, one method, and a few minutes. The bytes still go straight to R2 —
// nothing large passes through here.
//
// THE OWNERSHIP PROBLEM, AND THE CLAIM
// ------------------------------------
// Keys are `missions/{missionId}/photos/{photoId}.jpg`, and a mission id is
// generated offline as `ms-{base36}-{seq}` — guessable. An authenticated user
// could therefore ask for an upload URL inside somebody else's mission and
// overwrite their evidence. `geo.claim_mission` makes the first caller the owner
// for good; every later presign for that mission must come from them or it is
// refused. This is checked BEFORE anything is signed.
import { corsHeaders } from "../_shared/cors.ts";
import { BadRequestError, errorResponse, json } from "../_shared/enterprise/errors.ts";
import { resolveActor as realResolveActor, type Actor } from "../_shared/enterprise/auth.ts";
import { serviceClient } from "../_shared/enterprise/clients.ts";
import { requireEnterprise as realRequireEnterprise } from "../_shared/enterprise/authz.ts";
import {
  ALLOWED_IMAGE_TYPES, extensionFor, photoKeyFor, presignR2Url, r2ConfigFromEnv,
  type R2Config,
} from "../_shared/r2/sign.ts";

// Re-exported because the extension rule and the key shape are one decision and
// now live together in `sign.ts` — but this is where callers and tests have
// always looked for it.
export { extensionFor };

/** Long enough for a large photo on a bad link; short enough to be worthless if leaked. */
export const UPLOAD_EXPIRES_S = 900;
/**
 * Read URLs are shorter-lived than uploads.
 *
 * A read URL is the sensitive one: it exposes the photograph itself, and it is
 * handed to a model and written into logs on the way. Ten minutes is enough for
 * an analysis pass and not enough to be worth passing on.
 */
export const READ_EXPIRES_S = 600;
/** One mission's worth. A request for more is a bug or an abuse, not a big mission. */
export const MAX_PHOTOS_PER_REQUEST = 100;

export interface PresignRequestItem {
  photoId: string;
  /** Only ever image types; anything else is refused rather than stored. */
  contentType?: string;
}

export interface PresignedItem {
  photoId: string;
  key: string;
  url: string;
  expiresIn: number;
}

/**
 * A photo id has to be safe to put in a key.
 *
 * Rejected rather than sanitised: a silently-rewritten id produces a key the
 * device did not expect, and then a database row pointing at an object that is
 * not there. Better to fail loudly at the only moment anyone is watching.
 */
export function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);
}

export interface PresignDeps {
  resolveActor: (req: Request) => Promise<Actor>;
  /**
   * The same entitlement gate `expeditions` applies.
   *
   * Without it this endpoint was the one unguarded door into object storage: any
   * signed-in account could obtain upload URLs, while the package that gives those
   * bytes meaning could never be stored, because `expeditions/sync` would refuse
   * it. The result was payable storage filling with objects no row would ever
   * reference and nothing would ever read. Gated here, the two halves of the
   * upload path agree about who is allowed to use it.
   */
  requireEnterprise: (actor: Actor) => Promise<void>;
  claimMission: (actor: Actor, missionId: string) => Promise<boolean>;
  config: () => { config: R2Config } | { missing: string[] } | { conflict: string };
  now: () => Date;
}

export const realDeps: PresignDeps = {
  resolveActor: realResolveActor,
  requireEnterprise: (a) => realRequireEnterprise(a, serviceClient()),
  claimMission: async (actor, missionId) => {
    // "geo", EXPLICITLY. `serviceClient()` defaults to the enterprise schema —
    // right for the entitlement check on the line above, wrong for this, and the
    // difference is invisible at the call site.
    //
    // MEASURED: `POST /rest/v1/rpc/claim_mission -> 404`, twice, two minutes
    // apart. PostgREST was looking for `enterprise.claim_mission`; the function
    // is `geo.claim_mission`. 404 is not one of the refusal statuses, so the
    // queue read it as a transient failure and kept retrying — no presigned URL
    // was ever issued, so no PUT was ever attempted, and the bucket was empty
    // while the screen said "UPLOADING 7".
    const { data, error } = await serviceClient("geo").rpc("claim_mission", {
      p_actor: actor.userId,
      p_mission: missionId,
    });
    if (error) throw new Error(error.message);
    return data === true;
  },
  config: () => r2ConfigFromEnv((k) => Deno.env.get(k)),
  now: () => new Date(),
};

function parseItems(body: unknown): { missionId: string; items: PresignRequestItem[] } {
  const b = (body ?? {}) as Record<string, unknown>;
  const missionId = typeof b.missionId === "string" ? b.missionId : "";
  if (!isSafeId(missionId)) throw new BadRequestError("missionId is missing or not a safe id");

  const raw = Array.isArray(b.photos) ? b.photos : null;
  if (!raw || raw.length === 0) throw new BadRequestError("photos must be a non-empty array");
  if (raw.length > MAX_PHOTOS_PER_REQUEST) {
    throw new BadRequestError(`at most ${MAX_PHOTOS_PER_REQUEST} photos per request`);
  }

  const items: PresignRequestItem[] = [];
  for (const r of raw) {
    const item = (r ?? {}) as Record<string, unknown>;
    const photoId = typeof item.photoId === "string" ? item.photoId : "";
    if (!isSafeId(photoId)) throw new BadRequestError(`photoId "${photoId}" is not a safe id`);
    const contentType = typeof item.contentType === "string" ? item.contentType.toLowerCase() : undefined;
    if (contentType && !ALLOWED_IMAGE_TYPES.has(contentType)) {
      // Field evidence is photographs. Anything else is refused rather than
      // stored and worried about later.
      throw new BadRequestError(`contentType "${contentType}" is not an accepted image type`);
    }
    items.push({ photoId, contentType });
  }
  return { missionId, items };
}

export async function handlePresign(req: Request, deps: PresignDeps = realDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (req.method !== "POST") throw new BadRequestError("POST only");
    const url = new URL(req.url);
    const mode = url.pathname.endsWith("/read") ? "read" : "upload";

    // WHO, before WHAT. The configuration check used to run first, which told an
    // unauthenticated caller whether the operator had set their storage secrets —
    // a small leak, and free to close now that there is a gate to put in front
    // of it.
    const actor = await deps.resolveActor(req);
    await deps.requireEnterprise(actor);

    const cfg = deps.config();
    if ("missing" in cfg) {
      // Named, not guessed at. An operator reading this can fix it in one step,
      // and the device can keep the photographs on disk meanwhile — which is a
      // legitimate state, not an outage.
      return json({
        error: "object storage is not configured",
        missing: cfg.missing,
      }, 503);
    }
    if ("conflict" in cfg) {
      // Two settings describing the same host, disagreeing. Signing against the
      // wrong one fails with nothing but "SignatureDoesNotMatch", so it is said
      // out loud here rather than discovered on every upload.
      return json({ error: "object storage is misconfigured", detail: cfg.conflict }, 503);
    }

    const { missionId, items } = parseItems(await req.json().catch(() => null));

    // BEFORE anything is signed.
    if (!(await deps.claimMission(actor, missionId))) {
      return json({ error: "this mission belongs to another user" }, 403);
    }

    const method = mode === "read" ? "GET" as const : "PUT" as const;
    const expiresIn = mode === "read" ? READ_EXPIRES_S : UPLOAD_EXPIRES_S;
    const at = deps.now();

    const presigned: PresignedItem[] = [];
    for (const item of items) {
      const key = photoKeyFor(missionId, item.photoId, item.contentType);
      presigned.push({
        photoId: item.photoId,
        key,
        url: await presignR2Url({ config: cfg.config, key, method, expiresIn, at }),
        expiresIn,
      });
    }

    return json({ missionId, method, items: presigned });
  } catch (e) {
    return errorResponse(e);
  }
}

// expeditions — the field sync API (Exploration Platform v2, Slice 2).
//
//   POST /expeditions/sync   drain a device outbox: expedition open/close,
//                            observations, and the traverse, in one round trip
//   GET  /expeditions        the caller's own expeditions, newest first
//
// WHY ONE ENDPOINT FOR THE WHOLE OUTBOX
// -------------------------------------
// The client is a phone on a cellular link in a wadi. Every round trip is a
// chance to fail, so a walk's worth of records goes up in one request and each
// entry is acknowledged individually: the device marks off what the server
// accepted and keeps the rest queued. A partial success is the normal outcome,
// not an error — so this never rolls the batch back over one bad entry.
//
// Every write is an UPSERT keyed on the device's own id (Architecture v2 §6), so
// a retry after a timeout cannot duplicate an expedition, a pin or a traverse.
//
// Writes go through the enterprise.* RPCs (service role, SECURITY DEFINER, actor
// passed explicitly); reads use the user-scoped client so RLS applies. Deps are
// injected for tests, matching enterprise-samples.
import { corsHeaders } from "../_shared/cors.ts";
import { BadRequestError, errorResponse, json } from "../_shared/enterprise/errors.ts";
import { resolveActor as realResolveActor, type Actor } from "../_shared/enterprise/auth.ts";
import { serviceClient, userClient } from "../_shared/enterprise/clients.ts";
import { requireEnterprise as realRequireEnterprise } from "../_shared/enterprise/authz.ts";

/** One queued record from the device, exactly as lib/sync/outbox.ts holds it. */
export interface SyncEntry {
  localId: string;
  kind: "expedition.open" | "expedition.close" | "observation" | "track" | "mission.package";
  sessionId: string;
  payload: Record<string, unknown>;
}

/** Per-entry outcome. The device marks off `ok`, keeps and retries the rest. */
export interface SyncResult {
  localId: string;
  kind: string;
  ok: boolean;
  /** True when the failure is the entry's own fault and retrying cannot help. */
  permanent?: boolean;
  error?: string;
}

const KINDS = ["expedition.open", "expedition.close", "observation", "track", "mission.package"];
/** A walk's worth of records, not a database import. */
export const MAX_ENTRIES = 500;

export interface Deps {
  resolveActor: (req: Request) => Promise<Actor>;
  requireEnterprise: (actor: Actor) => Promise<void>;
  applyEntry: (actor: Actor, entry: SyncEntry) => Promise<void>;
  listExpeditions: (req: Request, actor: Actor) => Promise<unknown>;
}

/**
 * Errors the device must not retry.
 *
 * An observation whose expedition was never opened, or a track with one point,
 * will fail identically for ever. Telling the device so lets it stop asking —
 * and, crucially, stop holding a queue slot open on a phone in the field.
 */
/**
 * Errors that are the ENTRY'S OWN FAULT, and only those.
 *
 * A track with one point will fail identically for ever, so telling the device to
 * stop asking is a kindness. Everything else must keep its place in the queue,
 * because a queue entry retired by mistake is field evidence deleted — the
 * photographs stay in R2 and the observation is never assessed again.
 */
const DATA_FAULTS = [
  /no_data_found/i,             // the parent record genuinely does not exist
  /invalid_parameter_value/i,
  /at least two points/i,       // a track that is a single fix
  /invalid input/i,
  /violates check/i,
];

/**
 * Errors that are OURS, and must never retire an entry however they read.
 *
 * Checked FIRST, and this order is the fix. `isPermanent` used to match
 * `/not found/i`, and PostgREST's message for a missing function is "Could not
 * find the function enterprise.upsert_mission_package in the schema cache" —
 * "not find", not "not found". One letter stood between a schema-name mistake
 * and every finished section on every phone being silently discarded, and that
 * mistake was made three times today.
 *
 * Authorization is here on purpose, against the obvious reading. A token without
 * the entitlement is not the observation's fault and it is not for ever: the
 * account is enabled, the geologist signs in again, and the queue should still
 * be holding the day's work when it is.
 */
const OURS_NEVER_PERMANENT = [
  /could not find the function/i,   // PostgREST: wrong schema, or not deployed
  /schema cache/i,
  /permission denied/i,             // a missing GRANT is an operator error
  /jwt|unauthorized|forbidden|not enabled/i,
  /timeout|timed out|network|fetch failed|socket|connection/i,
  /5\d\d/,                          // any upstream server error
];

export function isPermanent(message: string): boolean {
  if (OURS_NEVER_PERMANENT.some((re) => re.test(message))) return false;
  return DATA_FAULTS.some((re) => re.test(message));
}

export const defaultDeps: Deps = {
  resolveActor: realResolveActor,
  requireEnterprise: (a) => realRequireEnterprise(a, serviceClient()),

  applyEntry: async (actor, entry) => {
    const svc = serviceClient();
    const p = entry.payload;

    switch (entry.kind) {
      case "expedition.open": {
        const { error } = await svc.rpc("open_expedition", {
          p_actor: actor.userId,
          p_session: entry.sessionId,
          p_started: p.started_at,
          p_project: p.project_id ?? null,
        });
        if (error) throw new Error(error.message);
        return;
      }
      case "expedition.close": {
        const { error } = await svc.rpc("close_expedition", {
          p_actor: actor.userId,
          p_session: entry.sessionId,
          p_ended: p.ended_at,
          p_distance_m: Number(p.distance_m ?? 0),
          p_moving_ms: Number(p.moving_ms ?? 0),
          p_observation_count: Number(p.observation_count ?? 0),
          p_closed_by: String(p.closed_by ?? "ended"),
        });
        if (error) throw new Error(error.message);
        return;
      }
      case "observation": {
        const { error } = await svc.rpc("upsert_field_observation", {
          p_actor: actor.userId,
          p_session: entry.sessionId,
          p_obs: { ...p, local_id: entry.localId },
        });
        if (error) throw new Error(error.message);
        return;
      }
      case "track": {
        const { error } = await svc.rpc("upsert_expedition_track", {
          p_actor: actor.userId,
          p_session: entry.sessionId,
          p_points: p.points ?? [],
          p_distance_m: Number(p.distance_m ?? 0),
          p_moving_ms: Number(p.moving_ms ?? 0),
        });
        if (error) throw new Error(error.message);
        return;
      }
      case "mission.package": {
        // A finished section: the mission, its package and one row per
        // photograph, in a single transaction. The bytes went to R2 separately
        // and directly; nothing here touches them, and `uploaded_at` stays null
        // until the verification pass has actually seen each object.
        // "geo", EXPLICITLY, and it is the only case in this switch that needs it.
        // The other four RPCs are `enterprise.*`, which is what `svc` is scoped to;
        // `upsert_mission_package` is `geo.*`, so the default client asked PostgREST
        // for `enterprise.upsert_mission_package` and got a 404.
        //
        // MEASURED: four photographs uploaded to R2, the expedition, the track and
        // the observation all filed — "all field records filed" on screen — and the
        // package alone silently absent, so `analyze-mission` answered
        // `404 no package for mission ms-msqjulse-3` every sixty seconds and the
        // report sat on AWAITING ANALYSIS. Four of five working is what made it look
        // like anything other than a schema name.
        const { error } = await serviceClient("geo").rpc("upsert_mission_package", {
          p_actor: actor.userId,
          p_package: { ...p, id: p.id ?? entry.localId },
        });
        if (error) throw new Error(error.message);
        return;
      }
    }

    // NEVER report success for a kind nothing handled.
    //
    // This switch had no default. `mission.package` was added to KINDS before its
    // case existed, so a package passed validation, fell through doing nothing,
    // and was acknowledged — the device would have marked a whole section's
    // evidence as delivered and stopped retrying it. Silence is the one outcome a
    // sync path must never produce.
    throw new Error(`no handler for kind "${entry.kind}"`);
  },

  listExpeditions: async (req, _actor) => {
    const db = userClient(req);
    const { data, error } = await db
      .from("expedition")
      .select("id,device_session_id,status,started_at,ended_at,distance_m,moving_ms," +
              "observation_count,sample_count,area_id,expedition_track(point_count,distance_m)")
      .is("deleted_at", null)
      .order("started_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return { expeditions: data ?? [] };
  },
};

/** Validates one entry's shape before it reaches the database. */
export function validateEntry(e: unknown): SyncEntry {
  if (!e || typeof e !== "object") throw new BadRequestError("entry must be an object");
  const x = e as Partial<SyncEntry>;
  if (typeof x.localId !== "string" || x.localId.length === 0 || x.localId.length > 200) {
    throw new BadRequestError("entry.localId must be a short string");
  }
  if (typeof x.kind !== "string" || !KINDS.includes(x.kind)) {
    throw new BadRequestError(`entry.kind must be one of ${KINDS.join(", ")}`);
  }
  if (typeof x.sessionId !== "string" || x.sessionId.length === 0 || x.sessionId.length > 200) {
    throw new BadRequestError("entry.sessionId must be a short string");
  }
  if (!x.payload || typeof x.payload !== "object") {
    throw new BadRequestError("entry.payload must be an object");
  }
  return x as SyncEntry;
}

/**
 * Order the batch so parents land before children.
 *
 * The device already queues oldest-first, but a batch may arrive after a long
 * offline stretch in which the queue was re-ordered by retries. An observation
 * whose expedition has not been opened is a permanent failure, and it is trivial
 * to avoid: open, then the contents, then close.
 */
export function orderEntries(entries: SyncEntry[]): SyncEntry[] {
  const rank: Record<string, number> = {
    "expedition.open": 0, observation: 1, track: 2, "expedition.close": 3,
  };
  return [...entries].sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9));
}

export async function handleExpeditions(req: Request, deps: Deps = defaultDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const actor = await deps.resolveActor(req);
    await deps.requireEnterprise(actor);

    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/expeditions\/?/, "").replace(/\/$/, "");

    if (req.method === "GET" && path === "") {
      return json(await deps.listExpeditions(req, actor));
    }

    if (req.method === "POST" && path === "sync") {
      const body = await req.json().catch(() => null);
      const raw = (body as { entries?: unknown[] } | null)?.entries;
      if (!Array.isArray(raw)) throw new BadRequestError("entries must be an array");
      if (raw.length > MAX_ENTRIES) throw new BadRequestError(`at most ${MAX_ENTRIES} entries per request`);

      const entries = orderEntries(raw.map(validateEntry));
      const results: SyncResult[] = [];

      // Sequential and independent. One rejected entry must not roll back the
      // walk that uploaded cleanly beside it.
      for (const entry of entries) {
        try {
          await deps.applyEntry(actor, entry);
          results.push({ localId: entry.localId, kind: entry.kind, ok: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : "sync failed";
          results.push({
            localId: entry.localId, kind: entry.kind, ok: false,
            permanent: isPermanent(message), error: message.slice(0, 300),
          });
        }
      }

      return json({
        results,
        accepted: results.filter((r) => r.ok).length,
        rejected: results.filter((r) => !r.ok).length,
      });
    }

    return errorResponse(new BadRequestError("unsupported route"));
  } catch (err) {
    return errorResponse(err);
  }
}

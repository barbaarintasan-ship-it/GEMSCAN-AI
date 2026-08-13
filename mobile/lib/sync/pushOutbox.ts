// Draining the outbox — the only place in the field pipeline that needs a signal.
//
// Everything the geologist collects is already durable on the device before this
// runs (see lib/sync/outbox.ts). This is the part that may fail, and it is
// written so that failing is ordinary:
//
//   • one round trip per drain, because each one is a chance to fail;
//   • per-entry acknowledgement, because a partial success is the normal
//     outcome on a cellular link, not an error;
//   • entries the server calls PERMANENT are marked sent rather than retried
//     for ever — an observation whose expedition it will never accept is not
//     going to be accepted on the ninth attempt, and holding a queue slot open
//     for it on a phone in the field costs the records behind it.
//
// It never throws at the caller. A drain that cannot happen is not an error the
// geologist should see; the queue simply stays full and the status line says so.
import type { Outbox, OutboxEntry } from "./outbox";

// Read the same way every other API module in this app reads it.
const FUNCTIONS_URL = process.env.EXPO_PUBLIC_SUPABASE_FUNCTIONS_URL!;

/**
 * The network client, loaded only when there is actually something to push.
 *
 * NOT a top-level import, and that is deliberate. `lib/supabase` builds its
 * client at module scope and THROWS if the public URL or key is missing — which
 * is correct for a screen that cannot work without a server, and wrong here.
 * This module is reached from the exploration workspace, and the exploration
 * workspace is the one part of Luul Scan that has to keep working when
 * everything else is broken: no signal, no session, no configuration.
 *
 * Importing it up here made the offline field map depend, at load time, on the
 * network layer being constructible. A failure there took out the whole screen
 * before a single pixel was drawn.
 */
async function getSupabase(): Promise<{ auth: { getSession: () => Promise<{ data: { session: { access_token: string } | null } }> } } | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("../supabase").supabase;
  } catch {
    // No client, so nothing can be filed yet. The queue keeps the records.
    return null;
  }
}

/** Records per request. Matches the server's own cap. */
export const BATCH_SIZE = 200;

export interface PushResult {
  attempted: number;
  accepted: number;
  rejected: number;
  /**
   * Set when the drain could not happen, or happened and was refused wholesale.
   *
   * `forbidden` is separate from `transport` because the two need opposite
   * reactions and used to be reported identically. A 403 from the endpoint —
   * which is what an account outside the enterprise allowlist gets, since
   * /expeditions/sync calls requireEnterprise before it reads the body — was
   * thrown by postSync as a generic Error and counted as a transport failure. The
   * panel then showed a growing "failing" count with no hint that nothing was
   * wrong with the link, the records or the phone.
   */
  blocked: "offline" | "unauthenticated" | "forbidden" | "transport" | null;
  /** The reason, verbatim, when there is one. Never swallowed. */
  reason: string | null;
}

/** HTTP status carried out of postSync, so the caller can tell 403 from a timeout. */
class SyncHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "SyncHttpError";
  }
}

interface ServerResult {
  localId: string;
  kind: string;
  ok: boolean;
  permanent?: boolean;
  error?: string;
}

/**
 * Push whatever is due.
 *
 * `isOnline` is passed in rather than read here: the caller already knows, and a
 * drain triggered by the connection coming back should not have to ask again.
 */
export async function pushOutbox(
  outbox: Outbox,
  isOnline: boolean,
  deps: { post?: (entries: OutboxEntry[], token: string) => Promise<ServerResult[]> } = {},
): Promise<PushResult> {
  const empty: PushResult = { attempted: 0, accepted: 0, rejected: 0, blocked: null, reason: null };
  if (!isOnline) return { ...empty, blocked: "offline", reason: "no connection" };

  await outbox.load();
  const due = outbox.due().slice(0, BATCH_SIZE);
  if (due.length === 0) return empty;

  const client = await getSupabase();
  if (!client) return { ...empty, blocked: "unauthenticated", reason: "no API client" };

  // getSession() reaches storage and can reject. This module promises never to
  // throw at the caller, and it used to break that promise here — an unhandled
  // rejection that left the drain flag set and the reason unrecorded.
  let token: string | undefined;
  try {
    const { data } = await client.auth.getSession();
    token = data.session?.access_token;
  } catch (err) {
    return {
      ...empty,
      blocked: "unauthenticated",
      reason: err instanceof Error ? err.message : "session unreadable",
    };
  }
  // Not signed in. The queue waits: these are the geologist's own records and
  // they are not lost, they are simply not theirs to file yet.
  if (!token) return { ...empty, blocked: "unauthenticated", reason: "not signed in" };

  let results: ServerResult[];
  try {
    results = await (deps.post ?? postSync)(due, token);
  } catch (err) {
    // The whole batch stays queued, each entry counted as one attempt so the
    // backoff applies rather than a hot retry loop. The reason is written onto
    // every entry, which is what makes it visible in diagnostics afterwards.
    const message = err instanceof Error ? err.message : "sync failed";
    // Read off the error rather than `instanceof`: the status is the fact that
    // matters, and instanceof is unreliable across module and bundle boundaries.
    const status = Number((err as { status?: unknown })?.status) || 0;
    // 401/403 is the account, not the link. Still retried — an entitlement can be
    // granted while the phone is in a pocket — but never again described as a
    // network fault.
    const authRefused = status === 401 || status === 403;
    for (const e of due) await outbox.markFailed(e.localId, e.kind, message);
    return {
      attempted: due.length,
      accepted: 0,
      rejected: due.length,
      blocked: authRefused ? "forbidden" : "transport",
      reason: message,
    };
  }

  const byKey = new Map(results.map((r) => [r.kind + " " + r.localId, r]));
  let accepted = 0, rejected = 0;

  for (const e of due) {
    const r = byKey.get(e.kind + " " + e.localId);
    if (!r) {
      // The server said nothing about this entry. Treat it as unfinished — never
      // as done, because "no answer" is not "accepted".
      await outbox.markFailed(e.localId, e.kind, "no result returned");
      rejected++;
      continue;
    }
    if (r.ok) {
      await outbox.markSent(e.localId, e.kind);
      accepted++;
    } else if (r.permanent) {
      // Retrying will fail identically. Retired from the queue WITH its reason,
      // so the failure stays visible in diagnostics instead of vanishing.
      await outbox.markRejected(e.localId, e.kind, r.error ?? "rejected");
      rejected++;
    } else {
      await outbox.markFailed(e.localId, e.kind, r.error ?? "rejected");
      rejected++;
    }
  }

  return { attempted: due.length, accepted, rejected, blocked: null, reason: null };
}

async function postSync(entries: OutboxEntry[], token: string): Promise<ServerResult[]> {
  const res = await fetch(`${FUNCTIONS_URL}/expeditions/sync`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      entries: entries.map((e) => ({
        localId: e.localId, kind: e.kind, sessionId: e.sessionId, payload: e.payload,
      })),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SyncHttpError(res.status, `sync failed (${res.status}) ${body.slice(0, 200)}`);
  }
  const body = await res.json() as { results?: ServerResult[] };
  return body.results ?? [];
}

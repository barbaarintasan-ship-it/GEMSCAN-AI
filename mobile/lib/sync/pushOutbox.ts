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
import type { Outbox, OutboxAckOutcome, OutboxEntry } from "./outbox";
import { withTimeout } from "../withTimeout";
import { markPhase } from "../diagnostics/jsStall";
import { PACKAGE_OUTBOX_KIND } from "../exploration/packageStore";

// Read the same way every other API module in this app reads it.
const FUNCTIONS_URL = process.env.EXPO_PUBLIC_SUPABASE_FUNCTIONS_URL!;

/**
 * THE THIRD ~52 SECOND FREEZE. SYNC_TIMEOUT_MS (below) bounds postSync's
 * fetch, but this module reads its OWN session — a second, independent call
 * to supabase-js's getSession(), not the one AuthProvider already bounds
 * (lib/auth.tsx) — and it carried no ceiling of its own. MEASURED: fixing
 * the first two unbounded cold-start calls still left a drain stalling for
 * 51-52 seconds on this one.
 */
const GET_SESSION_TIMEOUT_MS = 8_000;

/**
 * THE ~52 SECOND FREEZE THIS FIXES.
 *
 * `postSync`'s fetch carried no timeout, so a request that never got an answer —
 * a stalled connection, a server that accepted the socket and then said
 * nothing — simply never resolved. MEASURED on a device in the field: five
 * session-resumes in a row each sat for 51,000-52,000 ms with the app
 * unresponsive, because `useExpeditionSync`'s drain runs "now" on mount and
 * `isOnline` flipping (a real signal underfoot) re-ran it again each time,
 * every attempt hanging on the same unbounded request.
 *
 * The fix is a ceiling, not a retry policy — the outbox already has one
 * (`markFailed`'s backoff). This only makes sure ONE attempt cannot hold the
 * geologist's phone hostage: a request that has not answered by the deadline
 * is aborted, counted as an ordinary transport failure, and the record it was
 * carrying is exactly where it was before — durable on the device, still
 * queued, and never lost. Fifteen seconds is long enough for a genuinely slow
 * link to still succeed and short enough that a stalled one never reads as a
 * frozen app.
 */
export const SYNC_TIMEOUT_MS = 15_000;

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
 * Has this entry's `permanent` verdict actually been confirmed?
 *
 * True only when the SAME reason was already recorded against this entry on a
 * previous attempt — `entry` here still holds whatever the last drain
 * persisted, since this is read before this pass's outcomes are applied. A
 * fresh entry (`attempts: 0`) or one whose stored reason differs has not been
 * confirmed, and a first-time-only `mission.package` rejection is not enough
 * on its own — see the call site in `pushOutbox`.
 */
export function isConfirmedPermanent(entry: OutboxEntry, error: string | undefined): boolean {
  return entry.attempts > 0 && entry.lastError === (error ?? "rejected");
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
  //
  // A stalled connection neither resolves nor rejects at all — see
  // GET_SESSION_TIMEOUT_MS above — so it is raced against a ceiling. A
  // timeout answers exactly like an empty session: no token, "not signed
  // in", queue stays full, drain retried on the outbox's own backoff.
  let token: string | undefined;
  try {
    const doneAuthPhase = markPhase("pushOutbox.getSession");
    const { data } = await withTimeout(
      client.auth.getSession(),
      GET_SESSION_TIMEOUT_MS,
      { data: { session: null } },
    );
    doneAuthPhase();
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
    // One persist for the whole batch, not one per entry — see
    // Outbox.applyResults() for why that distinction is load-bearing.
    await outbox.applyResults(
      due.map((e) => ({ localId: e.localId, kind: e.kind, result: "failed" as const, error: message })),
    );
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
  const outcomes: OutboxAckOutcome[] = [];

  for (const e of due) {
    const r = byKey.get(e.kind + " " + e.localId);
    if (!r) {
      // The server said nothing about this entry. Treat it as unfinished — never
      // as done, because "no answer" is not "accepted".
      outcomes.push({ localId: e.localId, kind: e.kind, result: "failed", error: "no result returned" });
      rejected++;
      continue;
    }
    if (r.ok) {
      outcomes.push({ localId: e.localId, kind: e.kind, result: "sent" });
      accepted++;
    } else if (r.permanent) {
      if (e.kind === PACKAGE_OUTBOX_KIND && !isConfirmedPermanent(e, r.error)) {
        // A finished section's package is the one entry routed to a
        // non-default schema (geo, not enterprise) — see expeditions/handler.ts
        // — which made it the one kind a schema-routing mistake could hit. THE
        // INCIDENT THIS GUARDS AGAINST: a wrong-schema deploy answered every
        // mission.package with a 404 that read as "this entry's own fault",
        // and the queue retired every one of them on the very first try, before
        // anyone could tell a deploy mistake from a real rejection. Treated as
        // an ordinary retryable failure instead: a genuine data fault reads
        // identically next attempt and is retired then, one backoff cycle
        // later; a deploy-window flake almost never reads the same way twice
        // and this is what stops it from ever reaching a terminal state on a
        // single bad response. Other kinds are unaffected — see
        // isConfirmedPermanent.
        outcomes.push({ localId: e.localId, kind: e.kind, result: "failed", error: r.error ?? "rejected" });
      } else {
        // Retrying will fail identically. Retired from the queue WITH its reason,
        // so the failure stays visible in diagnostics instead of vanishing.
        outcomes.push({ localId: e.localId, kind: e.kind, result: "rejected", error: r.error ?? "rejected" });
      }
      rejected++;
    } else {
      outcomes.push({ localId: e.localId, kind: e.kind, result: "failed", error: r.error ?? "rejected" });
      rejected++;
    }
  }
  // Every acknowledgement from this batch applied in memory, then ONE persist —
  // this drain used to call markSent/markFailed/markRejected per entry here,
  // each persisting the whole outbox on its own. See Outbox.applyResults().
  await outbox.applyResults(outcomes);

  return { attempted: due.length, accepted, rejected, blocked: null, reason: null };
}

async function postSync(entries: OutboxEntry[], token: string): Promise<ServerResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${FUNCTIONS_URL}/expeditions/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        entries: entries.map((e) => ({
          localId: e.localId, kind: e.kind, sessionId: e.sessionId, payload: e.payload,
        })),
      }),
      signal: controller.signal,
    });
  } finally {
    // Cleared on every exit, not just success — an aborted or rejected fetch
    // must not leave a timer pinned for SYNC_TIMEOUT_MS with nothing left to fire.
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SyncHttpError(res.status, `sync failed (${res.status}) ${body.slice(0, 200)}`);
  }
  const body = await res.json() as { results?: ServerResult[] };
  return body.results ?? [];
}

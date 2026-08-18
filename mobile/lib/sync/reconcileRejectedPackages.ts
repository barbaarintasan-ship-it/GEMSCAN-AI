// Recovering mission.package entries retired by the schema-routing incident.
//
// BACKGROUND. A deploy briefly routed `mission.package` sync entries at the
// wrong Postgres schema; PostgREST's 404 for that read as the entry's own
// fault, so the outbox retired those entries permanently (see pushOutbox.ts —
// isConfirmedPermanent is the fix that stops this happening again). The
// server bug is fixed. The entries it already retired are not: `due()`
// excludes anything with `sentAt` set, and nothing else in the outbox ever
// re-offers a rejected entry.
//
// The evidence itself is not lost. PackageStore never prunes an unanalysed
// package (see packageStore.ts), so the finished section this entry was
// carrying is still sitting on the device — only its delivery vehicle was
// retired. This module finds exactly those entries and requeues them through
// the same durable path finishSection() uses, so the evidence goes out on the
// next ordinary drain and nothing about it needs to be rebuilt.
//
// A REJECTED ENTRY IS THE COMMON CASE, BUT NOT THE ONLY ONE. MEASURED on a
// field phone: most of the incident's entries had no outbox trace left at
// all. `Outbox.prune()` drops the oldest SENT entries once the queue passes
// OUTBOX_MAX_ENTRIES — and `sentAt` is set on a rejected entry too, so months
// of field use pruned the evidence of the rejection right along with it,
// while `PackageStore` (which never prunes an unanalysed package) kept the
// package itself. A package with no matching outbox entry at all is
// therefore ALSO in scope: there is nothing recorded to weigh against
// resurrecting a real fault, and it is definitionally not making progress on
// its own. `isKnownDeploymentRejection` still gates the one case where there
// IS a recorded reason — an entry the outbox still calls "rejected" — so a
// genuine, current data fault (a malformed payload, say) is never retried
// just because this incident also happened.
import { PackageStore, PACKAGE_OUTBOX_KIND } from "../exploration/packageStore";
import { Outbox, outboxStateOf } from "./outbox";

const PERMANENT_PREFIX = "permanent: ";

/**
 * The exact PostgREST signature this incident produced.
 *
 * Narrower than the server's own `OURS_NEVER_PERMANENT` list on purpose: that
 * list also covers auth and transport failures, which were never what caused
 * THIS incident and have no business being resurrected by a recovery pass
 * that is meant to target one specific, already-diagnosed cause.
 */
const KNOWN_DEPLOYMENT_REJECTION = [
  /could not find the function/i,
  /could not find the table/i,
  /schema cache/i,
];

export function isKnownDeploymentRejection(lastError: string | null): boolean {
  if (!lastError) return false;
  const reason = lastError.startsWith(PERMANENT_PREFIX)
    ? lastError.slice(PERMANENT_PREFIX.length)
    : lastError;
  return KNOWN_DEPLOYMENT_REJECTION.some((re) => re.test(reason));
}

export interface ReconcileResult {
  /** Mission ids whose package was requeued this pass. */
  requeuedMissionIds: string[];
}

/**
 * Find and requeue the incident's victims. Safe to call on every app open:
 * a package whose entry is still live (queued/retrying/failing) or already
 * `synced` is left untouched, so a repeat call does no work for it. A
 * requeue that turns out to have already been delivered is still harmless —
 * `upsert_mission_package` is `ON CONFLICT (id) DO UPDATE` — but this only
 * ever reaches for that fallback when there is no better signal to trust.
 */
export async function reconcileRejectedPackages(
  store: PackageStore,
  outbox: Outbox,
): Promise<ReconcileResult> {
  await store.load();
  await outbox.load();

  const requeuedMissionIds: string[] = [];
  for (const p of store.awaitingAnalysis()) {
    const entry = outbox.all().find((e) => e.localId === p.id && e.kind === PACKAGE_OUTBOX_KIND);

    if (entry) {
      if (outboxStateOf(entry) !== "rejected") continue; // synced, queued, retrying, failing — leave alone
      if (!isKnownDeploymentRejection(entry.lastError)) continue; // a real, still-valid rejection
    }
    // No entry at all: nothing recorded says this is a genuine fault, and a
    // package with no live outbox trace is not going to deliver itself.

    await store.enqueue(p, outbox);
    requeuedMissionIds.push(p.id);
  }
  return { requeuedMissionIds };
}

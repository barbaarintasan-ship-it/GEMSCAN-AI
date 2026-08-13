// What a sample's status SAYS, in one place.
//
// The detail screen already had labels, a stall threshold and a retry. The
// collection list did not — it rendered the raw column, so a geologist scrolling
// their own samples read "Ai_processing" nine times over. Two screens describing
// the same row differently is how a working analysis and a dead one came to look
// identical for a day and a half.
//
// So the vocabulary lives here and both screens read it.
//
// THE STALL. `mark_analysis_started` stamps `ai_attempted_at` and sets
// `ai_processing`; `mark_analysis_failed` is what moves it on. When the edge
// isolate running the analysis is KILLED — a wall-clock or CPU limit, which is
// what happens to a sample carrying many photographs — neither runs, and the row
// keeps `ai_processing` for ever with no error recorded anywhere. Migration 0092
// predicted exactly this in its own comment: "a row with this set and status
// still ai_processing is a run that died mid-flight."
//
// Nothing sweeps those rows. So the client names them, because the client is
// where someone is waiting: past this threshold, a run is not running.

/** A run older than this that has not finished is not running any more. */
export const STALLED_AFTER_MS = 10 * 60 * 1000;

/** Human-friendly labels for the production lifecycle (§13). */
export const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  ready: "Ready",
  uploading: "Uploading",
  submitted: "Submitted",
  ai_processing: "Analysing…",
  ai_completed: "Analysis ready",
  // A failed analysis has to LOOK failed. Left unlabelled it fell through to
  // "ai failed" via the underscore replacement, which reads as a shrug.
  ai_failed: "Analysis failed",
  awaiting_review: "Waiting for geologist",
  verified: "Verified",
  needs_more_data: "Needs more data",
  rejected: "Rejected",
  community_confirmed: "Community confirmed",
  expert_verified: "Expert verified",
  lab_verified: "Lab verified",
  held: "Held",
  held_on_device: "On device",
};

export function isStalled(attemptedAt: string | null | undefined, now = Date.now()): boolean {
  if (!attemptedAt) return false;
  const t = Date.parse(attemptedAt);
  return Number.isFinite(t) && now - t > STALLED_AFTER_MS;
}

/** How a row should read, and whether it wants attention. */
export interface StatusView {
  label: string;
  /** True when the geologist should do something about it. */
  attention: boolean;
  /** True when a re-analysis would help — a dead run, or one that failed. */
  retryable: boolean;
}

/**
 * One row's status, resolved.
 *
 * A stalled run reads as stalled rather than as "Analysing…", because the second
 * is a claim the app cannot support: nothing is analysing it. That distinction is
 * the whole of what the field was missing.
 */
export function statusView(
  row: { status: string; ai_error?: string | null; ai_attempted_at?: string | null },
  now = Date.now(),
): StatusView {
  const stalled = row.status === "ai_processing" && isStalled(row.ai_attempted_at, now);
  if (stalled) {
    return { label: "Analysis stalled", attention: true, retryable: true };
  }
  if (row.status === "ai_failed" || (row.ai_error && row.status !== "ai_completed")) {
    return { label: STATUS_LABELS.ai_failed, attention: true, retryable: true };
  }
  return {
    label: STATUS_LABELS[row.status] ?? row.status.replace(/_/g, " "),
    attention: row.status === "needs_more_data" || row.status === "rejected",
    retryable: false,
  };
}

/** Rows whose analysis is dead or failed, so the list can offer one recovery. */
export function retryableRows<T extends { id: string; status: string; ai_error?: string | null; ai_attempted_at?: string | null; local?: unknown }>(
  rows: readonly T[],
  now = Date.now(),
): T[] {
  // Only rows the SERVER holds: a sample still on the device has no analysis to
  // restart, and asking the server about it would 404.
  return rows.filter((r) => !isLocalOnly(r) && statusView(r, now).retryable);
}

function isLocalOnly(row: { local?: unknown }): boolean {
  const l = row.local as { state?: string } | undefined;
  return !!l && l.state !== "uploaded";
}

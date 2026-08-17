// Collecting the AI geologist's reading, once there is a network to collect it on.
//
// The mirror of pushPhotos: that file gets evidence OUT, this one brings the
// assessment BACK. Same rules, for the same reasons.
//
// NEVER THROWS at the caller. A field sync loop that can be broken by a bad
// response is a loop that stops running, and a loop that stops running is a
// geologist staring at "waiting for analysis" for ever with no idea why.
//
// POLLING IS THE NORMAL CASE, NOT A FALLBACK. A section is finished on a mountain
// with no signal; the package uploads hours later from a truck; the analysis takes
// half a minute after that. There is no moment where the device can simply wait
// for a reply, so it asks again each time the sync loop runs. The server makes
// that safe — a mission that already has a report returns it without calling the
// model — so asking repeatedly costs one small request and never a second reading.
import type { PackageStore } from "../exploration/packageStore";
import type { PackageAnalysis } from "../exploration/evidencePackage";
import { withTimeout } from "../withTimeout";

/**
 * supabase.functions.invoke() reads the current session to sign its request,
 * the same call that carried no timeout in lib/auth.tsx, lib/appUpdate.ts and
 * lib/sync/pushOutbox.ts — each of which produced a MEASURED 51-52 second
 * freeze before being bounded. This call reaches the network on every sync
 * pass, not just cold start, so it gets the same ceiling on principle.
 */
export const INVOKE_TIMEOUT_MS = 8_000;

/** What the analyze-mission function answers with. */
interface AnalyzeResponse {
  status?: "analysed" | "blocked" | "refused" | "failed";
  reportId?: string;
  outcome?: { status?: string; findings?: PackageAnalysis; reason?: string; detail?: string };
  missing?: Array<{ id: string; reason: string }>;
  error?: string;
  detail?: string;
}

export interface PullAnalysisResult {
  /** Assessments that came back and were written to the store. */
  collected: number;
  /** Missions still waiting on photographs to finish uploading. */
  waitingOnPhotos: number;
  /** Missions the server recorded as failed. Retryable, but not by asking again. */
  failed: number;
  blocked: "offline" | "unauthenticated" | "unconfigured" | null;
  reason: string | null;
}

const EMPTY: PullAnalysisResult = {
  collected: 0, waitingOnPhotos: 0, failed: 0, blocked: null, reason: null,
};

/**
 * How many missions to ask about in one pass.
 *
 * Each is a separate request that may run a model. A geologist coming back from a
 * week in the field can have a dozen unanalysed sections, and asking for all of
 * them the instant a bar of signal appears is how the whole batch times out
 * together. They will be collected over the next few passes instead.
 */
export const MAX_PER_PASS = 3;

export async function pullAnalysis(
  store: PackageStore,
  isOnline: boolean,
  deps: {
    invoke?: (missionId: string) => Promise<{ status: number; body: AnalyzeResponse }>;
  } = {},
): Promise<PullAnalysisResult> {
  if (!isOnline) return { ...EMPTY, blocked: "offline", reason: "no connection" };

  await store.load();
  const waiting = store.awaitingAnalysis().slice(0, MAX_PER_PASS);
  if (waiting.length === 0) return EMPTY;

  const invoke = deps.invoke ?? (async (missionId: string) => {
    // Required lazily, like every other store in this app: `lib/supabase` throws
    // at import time when the environment is not configured, and that would make
    // this module — and its tests — unloadable without a network stack.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { supabase } = require("../supabase");
    const { data, error } = await withTimeout(
      supabase.functions.invoke("analyze-mission", { body: { missionId } }),
      INVOKE_TIMEOUT_MS,
      { data: null, error: new Error("analyze-mission timed out") },
    );
    if (error) {
      // The STATUS is the answer here, not the message. 409 means the photographs
      // have not all arrived — an ordinary, temporary state that must not be
      // reported as a failure — and supabase-js gives every non-2xx the same
      // generic text.
      const ctx = (error as { context?: { status?: number } }).context;
      const status = ctx?.status ?? 0;
      let body: AnalyzeResponse = {};
      try {
        const res = (error as { context?: Response }).context;
        if (res && typeof (res as Response).json === "function") {
          body = await (res as Response).clone().json();
        }
      } catch { /* a body we cannot read is not worth failing over */ }
      return { status, body };
    }
    return { status: 200, body: (data ?? {}) as AnalyzeResponse };
  });

  let collected = 0, waitingOnPhotos = 0, failed = 0;
  let blocked: PullAnalysisResult["blocked"] = null;
  let reason: string | null = null;

  for (const pkg of waiting) {
    try {
      const { status, body } = await invoke(pkg.missionId);

      if (status === 200 && body.outcome?.findings) {
        // Disk first. A state saying the analysis arrived, with no analysis behind
        // it, is worse than the state never being reached.
        await store.attachAnalysis(pkg.id, body.outcome.findings);
        collected++;
        await store.noteAttempt(pkg.id, null);
        continue;
      }
      if (status === 409) {
        // WAITING, AND SAYING WHAT FOR. The server names the objects it could not
        // find in storage; without them the note is "waiting" again, which is what
        // the screen already said for three hours.
        const missing = Array.isArray(body.missing) ? body.missing.length : 0;
        await store.noteAttempt(
          pkg.id,
          missing > 0
            ? `HTTP 409 — the server cannot find ${missing} photograph(s) in storage yet`
            : "HTTP 409 — the server is still verifying the evidence",
        );
        waitingOnPhotos++;
        continue;
      }
      if (status === 503) {
        // Storage or the model is not configured. Not this mission's fault and not
        // worth marking against it — the next pass will find it unchanged.
        blocked = "unconfigured";
        reason = body.detail ?? body.error ?? "analysis is not configured";
        await store.noteAttempt(pkg.id, `HTTP 503 — ${reason}`);
        continue;
      }
      if (status === 401 || status === 403) {
        blocked = "unauthenticated";
        reason = "this account is not enabled for field analysis";
        await store.noteAttempt(pkg.id, `HTTP ${status} — ${reason}`);
        // Every other mission will answer identically. Stop asking this pass.
        break;
      }
      if (body.outcome?.status === "failed" || body.outcome?.status === "refused") {
        // The REASON, written beside the evidence. "Analysis failed" with nothing
        // after it is a dead end for someone standing on a mountain; "the model
        // was unavailable" tells them to try again, and "this package is
        // incomplete" tells them not to bother.
        await store.attachError(
          pkg.id,
          body.outcome.detail
            ? `${body.outcome.reason}: ${body.outcome.detail}`
            : (body.outcome.reason ?? "analysis failed"),
        );
        failed++;
        await store.noteAttempt(pkg.id, null);
        continue;
      }
      // ANYTHING ELSE IS STILL NOT NOTHING. The package is left alone — it may
      // well come right on the next pass — but the answer is written down, because
      // a screen that says "awaiting analysis" over a server replying 500 every
      // sixty seconds is not waiting, it is stuck, and only the log knew.
      await store.noteAttempt(
        pkg.id,
        `HTTP ${status}${body.error ? ` — ${body.error}` : ""}${
          body.detail ? `: ${body.detail}` : ""
        }`,
      );
    } catch (e) {
      // A single bad response must not stop the rest being collected.
      reason = reason ?? (e instanceof Error ? e.message : String(e));
    }
  }

  return { collected, waitingOnPhotos, failed, blocked, reason };
}

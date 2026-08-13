// Nothing outbound may hang, because a hang is the one failure nothing catches.
//
// WHAT THIS IS FOR. Twelve samples sat at `ai_processing` overnight with
// `ai_error` null and `updated_at` equal to `ai_attempted_at` to the microsecond
// — meaning not one write reached the row after `mark_analysis_started`. That is
// not a thrown error. Every throw in analyze-sample is caught and recorded; a
// caught error would have written a reason. Zero writes means no code ran at all
// after the run began, which happens in exactly one way: the isolate was KILLED
// on the wall clock while a promise was still pending.
//
// And there were five unbounded `fetch` calls to hang on — two image reads and
// two Gemini calls, none with a timeout or an AbortController. A `try/catch`
// around a promise that never settles never executes. That is why the earlier
// "vision failure is not fatal" fix did not help: it handles a REJECTION, and a
// hang is not one.
//
// So every outbound call gets a deadline. A hang becomes a rejection, a rejection
// is caught, and the sample is told why instead of being abandoned mid-run.

/**
 * `fetch` that cannot outlive `ms`.
 *
 * AbortController rather than a racing timer, so the socket is actually released
 * — a Promise.race leaves the request running and the isolate still holding it,
 * which is the thing being prevented.
 */
export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  ms = 30_000,
  label = "request",
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(input, { ...init, signal: ac.signal });
  } catch (e) {
    // AbortError is not a network fault, and saying so is the whole point: the
    // recorded reason has to name the timeout or the next person goes looking
    // for a connectivity problem that was never there.
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error(`${label} timed out after ${Math.round(ms / 1000)}s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A deadline around work that is not a single fetch — a stage, a loop of reads.
 *
 * This does NOT stop the underlying work; it stops WAITING for it, so the caller
 * can record a reason before the platform kills the isolate. Bounding the whole
 * stage is what makes the photo-download loop safe regardless of how many
 * photographs a sample carries, which per-call timeouts alone cannot do.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} exceeded its ${Math.round(ms / 1000)}s budget`)),
      ms,
    );
    work.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Stage budgets, chosen to fit inside one edge invocation with room to record.
 *
 * They must sum to comfortably less than the platform's wall clock, because the
 * point is to still be alive when the failure is written. Vision is bounded as a
 * WHOLE as well as per call, since its cost scales with the number of photographs
 * and that is the variable that was killing runs.
 */
export const BUDGET_MS = {
  /** HEAD probe for an image's size. Cheap; if it is slow, skip the check. */
  imageProbe: 4_000,
  /** One image download. */
  imageFetch: 10_000,
  /** One Gemini vision call. */
  visionGenerate: 30_000,
  /** The whole vision stage: probes, downloads and the model call together. */
  visionStage: 50_000,
  /** One Gemini reasoning call — this one IS the assessment, so it gets the most. */
  reasoningGenerate: 40_000,
  /** The whole reasoning stage. */
  reasoningStage: 45_000,
} as const;

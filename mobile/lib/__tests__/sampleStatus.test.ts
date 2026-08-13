// A dead analysis must not read as a live one.
//
// THE FIELD REPORT. Nine samples, some 28 hours old, all reading "Ai_processing"
// in My Samples. No results since the previous day. Two separate faults produced
// that screen:
//
//   1. The collection list printed the raw status column, so `ai_processing`
//      reached the geologist as "Ai_processing" — and, worse, a run that had died
//      overnight looked exactly like one in flight.
//   2. Nothing ever moves a killed run out of `ai_processing`.
//      `mark_analysis_started` sets it and stamps `ai_attempted_at`;
//      `mark_analysis_failed` is what clears it. When the edge isolate is killed
//      mid-run — a wall-clock limit, which is what a sample with many
//      photographs hits — neither runs. Migration 0092 wrote that prediction into
//      its own comment and nothing was ever built to act on it.
//
// The client cannot stop the isolate dying. It can refuse to describe a corpse as
// a patient, which is what these tests hold it to.
import {
  statusView, isStalled, retryableRows, STALLED_AFTER_MS, STATUS_LABELS,
} from "../samples/sampleStatus";

const NOW = Date.parse("2026-08-07T18:25:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("a run in flight and a run that died are not the same row", () => {
  test("a fresh attempt reads as analysing", () => {
    const v = statusView({ status: "ai_processing", ai_attempted_at: ago(60_000) }, NOW);
    expect(v.label).toBe("Analysing…");
    expect(v.retryable).toBe(false);
    expect(v.attention).toBe(false);
  });

  test("the same status past the threshold reads as STALLED", () => {
    const v = statusView({ status: "ai_processing", ai_attempted_at: ago(STALLED_AFTER_MS + 1000) }, NOW);
    expect(v.label).toBe("Analysis stalled");
    expect(v.retryable).toBe(true);
    expect(v.attention).toBe(true);
  });

  test("the field's actual rows — 28 hours at ai_processing — are stalled", () => {
    // 06/08 14:25, read at 07/08 18:25. This is the screen that was reported.
        const v = statusView({ status: "ai_processing", ai_attempted_at: "2026-08-06T14:25:34Z" }, NOW);
    expect(v.label).toBe("Analysis stalled");
    expect(v.retryable).toBe(true);
  });

  test("no attempt timestamp is not a stall — it was never started", () => {
    // Distinguishing these two was the whole point of 0092. A row with no
    // ai_attempted_at has not been tried, and claiming it stalled would be as
    // wrong as claiming it is running.
    expect(isStalled(null, NOW)).toBe(false);
    expect(isStalled(undefined, NOW)).toBe(false);
    expect(statusView({ status: "ai_processing", ai_attempted_at: null }, NOW).retryable).toBe(false);
  });

  test("an unparseable timestamp is not treated as infinitely old", () => {
    expect(isStalled("not a date", NOW)).toBe(false);
  });
});

describe("no raw database value ever reaches the geologist", () => {
  test("the value the field actually saw is translated", () => {
    expect(statusView({ status: "ai_processing", ai_attempted_at: ago(1000) }, NOW).label)
      .not.toMatch(/ai_processing/i);
  });

  test("every status the workflow can produce has a label", () => {
    // From 0061 and 0092 — the lifecycle as the database defines it.
    const lifecycle = [
      "draft", "ready", "uploading", "submitted", "ai_processing", "ai_completed",
      "ai_failed", "awaiting_review", "verified", "needs_more_data", "rejected",
      "community_confirmed", "expert_verified", "lab_verified", "held",
    ];
    for (const s of lifecycle) {
      expect(STATUS_LABELS[s]).toBeDefined();
      expect(STATUS_LABELS[s]).not.toContain("_");
    }
  });

  test("an unknown status degrades to something readable, never to a crash", () => {
    expect(statusView({ status: "some_future_state" }, NOW).label).toBe("some future state");
  });

  test("a failed analysis looks failed", () => {
    expect(statusView({ status: "ai_failed" }, NOW)).toMatchObject({
      label: "Analysis failed", attention: true, retryable: true,
    });
  });

  test("an error recorded against a finished analysis does not un-finish it", () => {
    // ai_completed with a stale ai_error is a completed analysis. Marking it
    // failed would send the geologist to re-run work that already succeeded.
    expect(statusView({ status: "ai_completed", ai_error: "old failure" }, NOW).retryable).toBe(false);
  });
});

describe("what the one-tap recovery will actually restart", () => {
  const rows = [
    { id: "live", status: "ai_processing", ai_attempted_at: ago(30_000) },
    { id: "dead", status: "ai_processing", ai_attempted_at: ago(STALLED_AFTER_MS * 3) },
    { id: "failed", status: "ai_failed", ai_error: "vision timeout" },
    { id: "done", status: "ai_completed" },
    { id: "reviewed", status: "verified" },
    // Still on the phone: there is no server-side analysis to restart, and
    // asking about it would 404.
    { id: "onDevice", status: "held_on_device", local: { state: "pending" } },
    { id: "filed", status: "ai_processing", ai_attempted_at: ago(STALLED_AFTER_MS * 2), local: { state: "uploaded" } },
  ];

  test("only the dead and the failed, and only ones the server holds", () => {
    expect(retryableRows(rows, NOW).map((r) => r.id)).toEqual(["dead", "failed", "filed"]);
  });

  test("a healthy collection offers nothing — no banner over working samples", () => {
    const healthy = [
      { id: "a", status: "ai_completed" },
      { id: "b", status: "ai_processing", ai_attempted_at: ago(5_000) },
      { id: "c", status: "awaiting_review" },
    ];
    expect(retryableRows(healthy, NOW)).toEqual([]);
  });

  test("a sample held on the device is never offered for re-analysis", () => {
    const local = [{ id: "x", status: "held_on_device", local: { state: "failed" } }];
    expect(retryableRows(local, NOW)).toEqual([]);
  });
});

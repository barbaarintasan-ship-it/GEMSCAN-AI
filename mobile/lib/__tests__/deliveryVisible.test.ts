// A screen that says "waiting" must be able to say what for.
//
// MEASURED, over one afternoon in the field and three hours at a desk:
//
//   "UPLOADING 7"        for forty-five minutes, over seven photographs that were
//                        never going to move — every presign was answering 404
//                        because the RPC was being looked for in the wrong schema.
//
//   "AWAITING ANALYSIS"  for three hours, while `analyze-mission` answered every
//                        sixty seconds. Twenty-six of those answers were HTTP 500
//                        with `permission denied for table mission_package`.
//
// Both were real bugs and both are fixed. What made them cost an afternoon each was
// not their difficulty: it was that the app had exactly one word for four different
// situations and threw the server's answer away. The only way to learn which of
// them was happening was to open the Supabase dashboard.
//
// These tests pin the two rules that came out of it:
//
//   1. `pendingFor` counts four states; the pill must not call all four "uploading"
//   2. every answer that is not a report gets written down where a geologist stands
import { pullAnalysis } from "../sync/pullAnalysis";
import { PackageStore, PACKAGE_STORAGE_KEY } from "../exploration/packageStore";
import {
  EVIDENCE_PACKAGE_VERSION, type EvidencePackage,
} from "../exploration/evidencePackage";
import { PhotoUploadQueue, PHOTO_QUEUE_STORAGE_KEY } from "../sync/photoUploadQueue";
import { reportStateOf } from "../../app/(app)/enterprise/reports";
import type { KeyValueAdapter } from "../sync/outbox";

const NOW = 1_760_000_000_000;

function memoryStorage(key?: string, seed?: unknown): KeyValueAdapter {
  const data = new Map<string, string>();
  if (key && seed) data.set(key, JSON.stringify(seed));
  return {
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => { data.set(k, v); },
  };
}

function pkg(id: string, over: Partial<EvidencePackage> = {}): EvidencePackage {
  return {
    version: EVIDENCE_PACKAGE_VERSION, id, missionId: id, explorationSessionId: "ex-1",
    createdAt: NOW,
    targetCell: "87abc", targetCentre: { lat: 9.5, lng: 43.1 },
    hotspot: null, commodity: "gold", prospectivityScore: 0.4, targetReasons: [],
    geologyContext: null, terrainContext: null, structuralContext: [], coverage: null,
    engineReadings: null,
    observations: [], track: [], arrivedAt: null, completedAt: NOW,
    analysis: null,
    ...over,
  } as EvidencePackage;
}

const FINDINGS = {
  version: 1, commodity: "gold", interest: "worth_following_up",
  confidence: "low", evidence: [], missingEvidence: [],
  recommendations: [], model: "test-model", analysedAt: 1,
} as never;

const store = (seed: EvidencePackage[]) =>
  new PackageStore({ storage: memoryStorage(PACKAGE_STORAGE_KEY, seed), now: () => NOW });

/** A queue seeded straight into its stored shape, one entry per state. */
function queueWith(states: Array<{ id: string; state: string; missionId?: string }>) {
  const items = states.map((s, i) => ({
    photoId: s.id, missionId: s.missionId ?? "ms-1",
    localUri: `file:///p${i}.jpg`, contentType: "image/jpeg",
    state: s.state, attempts: 0, lastAttemptAt: null,
    r2Key: null, bytes: null, uploadedAt: null, lastError: null,
    queuedAt: NOW,
  }));
  return new PhotoUploadQueue({
    storage: memoryStorage(PHOTO_QUEUE_STORAGE_KEY, items), now: () => NOW,
  });
}

describe("1. the four photo states are four numbers, not one", () => {
  test("countsFor separates them", async () => {
    const q = queueWith([
      { id: "a", state: "uploaded" }, { id: "b", state: "pending" },
      { id: "c", state: "uploading" }, { id: "d", state: "failed" },
      { id: "e", state: "blocked" }, { id: "f", state: "blocked" },
    ]);
    await q.load();
    // `uploading` does not survive a load, and that is deliberate: an entry left
    // in it means the process died mid-PUT, so `load()` revives it to `pending`
    // rather than leaving work that nothing will ever pick up. Hence two pending.
    expect(q.countsFor("ms-1")).toEqual({
      uploaded: 1, pending: 2, uploading: 0, failed: 1, blocked: 2,
    });
  });

  test("it counts only the mission asked about", async () => {
    const q = queueWith([
      { id: "a", state: "blocked" }, { id: "b", state: "blocked", missionId: "ms-2" },
    ]);
    await q.load();
    expect(q.countsFor("ms-1").blocked).toBe(1);
    expect(q.countsFor("ms-2").blocked).toBe(1);
  });
});

describe("2. the pill no longer hides a refusal behind 'uploading'", () => {
  const p = pkg("ms-1");
  const counts = (o: Partial<Record<string, number>> = {}) => ({
    pending: 0, uploading: 0, uploaded: 0, failed: 0, blocked: 0, ...o,
  }) as never;

  test("REFUSED beats everything — it never resolves on its own", () => {
    expect(reportStateOf(p, counts({ blocked: 7, pending: 2 }))).toBe("refused");
  });

  test("a failed photograph reads as retrying, not uploading", () => {
    expect(reportStateOf(p, counts({ failed: 7 }))).toBe("retrying");
  });

  test("only genuinely in-flight work reads as uploading", () => {
    expect(reportStateOf(p, counts({ pending: 3, uploading: 1 }))).toBe("uploading");
  });

  test("all delivered is waiting on the analysis, not on photographs", () => {
    expect(reportStateOf(p, counts({ uploaded: 7 }))).toBe("waiting");
  });

  test("THE FIELD READING: seven refused must not say 'uploading 7'", () => {
    // The exact state the phone was in for forty-five minutes.
    expect(reportStateOf(p, counts({ blocked: 7 }))).not.toBe("uploading");
  });

  test("an assessment that arrived outranks every photo state", () => {
    expect(reportStateOf(pkg("ms-1", { analysis: FINDINGS }), counts({ blocked: 7 })))
      .toBe("analysed");
  });
});

describe("3. retryNow revives BOTH resting states", () => {
  test("failed and blocked both come back due", async () => {
    // `due()` skips blocked for ever, so without this a refusal is permanent and
    // the only cure is reinstalling the app.
    const q = queueWith([
      { id: "a", state: "blocked" }, { id: "b", state: "failed" },
      { id: "c", state: "uploaded" },
    ]);
    await q.load();
    expect(q.due().length).toBe(1);          // the failed one only
    expect(await q.retryNow("ms-1")).toBe(2);
    expect(q.due().length).toBe(2);
    expect(q.countsFor("ms-1").uploaded).toBe(1);   // delivered work is untouched
  });

  test("it leaves other missions alone", async () => {
    const q = queueWith([
      { id: "a", state: "blocked" }, { id: "b", state: "blocked", missionId: "ms-2" },
    ]);
    await q.load();
    expect(await q.retryNow("ms-1")).toBe(1);
    expect(q.countsFor("ms-2").blocked).toBe(1);
  });
});

describe("4. every answer that is not a report is written down", () => {
  test("409 says how many photographs the server cannot find", async () => {
    const s = store([pkg("ms-1")]);
    await pullAnalysis(s, true, {
      invoke: async () => ({
        status: 409,
        body: { missing: [{ id: "p1", reason: "absent" }, { id: "p2", reason: "absent" }] },
      }),
    });
    await s.load();
    const note = s.get("ms-1")?.analysisNote ?? "";
    expect(note).toContain("409");
    expect(note).toContain("2");
    // Waiting is not failing: the state must not flip.
    expect(s.get("ms-1")?.analysisError ?? null).toBeNull();
  });

  test("THE THREE-HOUR CASE: a 500 is recorded, not swallowed", async () => {
    const s = store([pkg("ms-1")]);
    await pullAnalysis(s, true, {
      invoke: async () => ({
        status: 500, body: { error: "permission denied for table mission_package" },
      }),
    });
    await s.load();
    const note = s.get("ms-1")?.analysisNote ?? "";
    expect(note).toContain("500");
    expect(note).toContain("permission denied");
  });

  test("503 records what is unconfigured", async () => {
    const s = store([pkg("ms-1")]);
    await pullAnalysis(s, true, {
      invoke: async () => ({ status: 503, body: { detail: "storage is not configured" } }),
    });
    await s.load();
    expect(s.get("ms-1")?.analysisNote ?? "").toContain("503");
  });

  test("403 records the refusal", async () => {
    const s = store([pkg("ms-1")]);
    await pullAnalysis(s, true, {
      invoke: async () => ({ status: 403, body: {} }),
    });
    await s.load();
    expect(s.get("ms-1")?.analysisNote ?? "").toContain("403");
  });

  test("a report that arrives CLEARS the note", async () => {
    const s = store([pkg("ms-1", { analysisNote: "HTTP 500 — something" })]);
    await pullAnalysis(s, true, {
      invoke: async () => ({ status: 200, body: { outcome: { status: "analysed", findings: FINDINGS } } }),
    });
    await s.load();
    expect(s.get("ms-1")?.analysisNote ?? null).toBeNull();
    expect(s.get("ms-1")?.analysis).toBeTruthy();
  });

  test("the sync loop still never throws on a bad answer", async () => {
    const s = store([pkg("ms-1")]);
    await expect(pullAnalysis(s, true, {
      invoke: async () => { throw new Error("socket closed"); },
    })).resolves.toBeTruthy();
  });
});

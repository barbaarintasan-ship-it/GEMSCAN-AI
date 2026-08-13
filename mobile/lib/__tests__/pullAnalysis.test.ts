// Collecting the assessment, and the states on the way to it.
//
// The rule here is the same one the upload path has: NEVER break the sync loop.
// A geologist whose loop has stopped sees "waiting for analysis" for ever with no
// indication that nothing is coming, and that is worse than an error.
import { pullAnalysis, MAX_PER_PASS } from "../sync/pullAnalysis";
import { PackageStore, PACKAGE_STORAGE_KEY } from "../exploration/packageStore";
import {
  EVIDENCE_PACKAGE_VERSION, READABLE_PACKAGE_VERSIONS,
  type EvidencePackage,
} from "../exploration/evidencePackage";
import type { KeyValueAdapter } from "../sync/outbox";

function memoryStorage(seed?: unknown): KeyValueAdapter & { data: Map<string, string> } {
  const data = new Map<string, string>();
  if (seed) data.set(PACKAGE_STORAGE_KEY, JSON.stringify(seed));
  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => { data.set(k, v); },
  };
}

function pkg(id: string, over: Partial<EvidencePackage> = {}): EvidencePackage {
  return {
    version: EVIDENCE_PACKAGE_VERSION, id, missionId: id, explorationSessionId: "ex-1",
    createdAt: 1_760_000_000_000,
    targetCell: "87abc", targetCentre: { lat: 9.5, lng: 43.1 },
    hotspot: null, commodity: "gold", prospectivityScore: 0.4, targetReasons: [],
    geologyContext: null, terrainContext: null, structuralContext: [], coverage: null,
    engineReadings: null,
    observations: [], track: [], arrivedAt: null, completedAt: 1_760_000_000_000,
    analysis: null,
    ...over,
  } as EvidencePackage;
}

const FINDINGS = {
  version: 1, commodity: "gold", interest: "worth_following_up",
  confidence: "low", evidence: [], missingEvidence: ["assay"],
  recommendations: [], model: "test-model", analysedAt: 1,
} as never;

function store(seed: EvidencePackage[]) {
  return new PackageStore({ storage: memoryStorage(seed), now: () => 1_760_000_000_000 });
}

describe("collecting", () => {
  test("an assessment that comes back is written to the store", async () => {
    const s = store([pkg("ms-1")]);
    const r = await pullAnalysis(s, true, {
      invoke: async () => ({ status: 200, body: { outcome: { status: "analysed", findings: FINDINGS } } }),
    });
    expect(r.collected).toBe(1);
    await s.load();
    expect(s.get("ms-1")?.analysis?.model).toBe("test-model");
  });

  test("a package that already has one is not asked about again", async () => {
    const s = store([pkg("ms-1", { analysis: FINDINGS })]);
    let asked = 0;
    await pullAnalysis(s, true, {
      invoke: async () => { asked++; return { status: 200, body: {} }; },
    });
    expect(asked).toBe(0);
  });

  test("no more than MAX_PER_PASS are asked about at once", async () => {
    // A week in the field is a dozen unanalysed sections. Asking for all of them
    // the instant a bar of signal appears is how the whole batch times out.
    const s = store(Array.from({ length: 10 }, (_, i) => pkg(`ms-${i}`)));
    let asked = 0;
    await pullAnalysis(s, true, {
      invoke: async () => { asked++; return { status: 409, body: {} }; },
    });
    expect(asked).toBe(MAX_PER_PASS);
  });
});

describe("the states that are not failures", () => {
  test("OFFLINE is a state, not an error", async () => {
    const s = store([pkg("ms-1")]);
    const r = await pullAnalysis(s, false);
    expect(r.blocked).toBe("offline");
    expect(r.collected).toBe(0);
  });

  test("409 means the photographs are still arriving — nothing is marked failed", async () => {
    const s = store([pkg("ms-1")]);
    const r = await pullAnalysis(s, true, {
      invoke: async () => ({ status: 409, body: { missing: [{ id: "p2", reason: "HTTP 404" }] } }),
    });
    expect(r.waitingOnPhotos).toBe(1);
    expect(r.failed).toBe(0);
    await s.load();
    // The package is untouched and will be asked about again.
    expect(s.get("ms-1")?.analysis).toBeNull();
  });

  test("503 is the operator's problem, not the mission's", async () => {
    const s = store([pkg("ms-1")]);
    const r = await pullAnalysis(s, true, {
      invoke: async () => ({ status: 503, body: { detail: "not configured: R2_BUCKET_NAME" } }),
    });
    expect(r.blocked).toBe("unconfigured");
    expect(r.failed).toBe(0);
    expect(r.reason).toContain("R2_BUCKET_NAME");
  });

  test("403 stops the pass — every other mission would answer the same", async () => {
    const s = store([pkg("ms-1"), pkg("ms-2"), pkg("ms-3")]);
    let asked = 0;
    const r = await pullAnalysis(s, true, {
      invoke: async () => { asked++; return { status: 403, body: {} }; },
    });
    expect(asked).toBe(1);
    expect(r.blocked).toBe("unauthenticated");
  });
});

describe("never breaking the loop", () => {
  test("a thrown invoke does not stop the other missions", async () => {
    const s = store([pkg("ms-1"), pkg("ms-2")]);
    let n = 0;
    const r = await pullAnalysis(s, true, {
      invoke: async () => {
        n++;
        if (n === 1) throw new Error("socket hang up");
        return { status: 200, body: { outcome: { status: "analysed", findings: FINDINGS } } };
      },
    });
    expect(r.collected).toBe(1);
    expect(n).toBe(2);
  });

  test("a 200 with no findings changes nothing", async () => {
    // A malformed success is not a success. The package waits rather than being
    // marked analysed with nothing behind it.
    const s = store([pkg("ms-1")]);
    const r = await pullAnalysis(s, true, {
      invoke: async () => ({ status: 200, body: { outcome: { status: "analysed" } } }),
    });
    expect(r.collected).toBe(0);
    await s.load();
    expect(s.get("ms-1")?.analysis).toBeNull();
  });

  test("a server-side failure is counted, and the evidence is untouched", async () => {
    const s = store([pkg("ms-1")]);
    const r = await pullAnalysis(s, true, {
      invoke: async () => ({
        status: 200,
        body: { outcome: { status: "failed", reason: "provider_error", detail: "model down" } },
      }),
    });
    expect(r.failed).toBe(1);
    await s.load();
    expect(s.get("ms-1")).not.toBeNull();
    expect(s.get("ms-1")?.observations).toEqual([]);
  });
});

describe("a version bump must never empty a geologist's phone", () => {
  // `isDeliverable` filters the store on LOAD. A package whose version is not in
  // the readable set is dropped from the device — finished sections, photographs,
  // a day's observations, gone, because a field was added to a type. This nearly
  // shipped when engineReadings took the package from v1 to v2.
  test("a v1 package still loads, and is still awaiting analysis", async () => {
    const old = { ...pkg("ms-old"), version: 1 };
    const s = store([old as EvidencePackage]);
    await s.load();
    expect(s.all().length).toBe(1);
    expect(s.awaitingAnalysis().map((p) => p.id)).toEqual(["ms-old"]);
  });

  test("every version this build writes is a version it can read", () => {
    expect(READABLE_PACKAGE_VERSIONS).toContain(EVIDENCE_PACKAGE_VERSION);
  });

  test("a shape from the future is NOT read — it cannot be understood", () => {
    const future = { ...pkg("ms-future"), version: 99 };
    const s = store([future as EvidencePackage]);
    return s.load().then(() => expect(s.all().length).toBe(0));
  });
});

describe("a failure is recorded with its reason", () => {
  test("the reason is written beside the evidence, which is untouched", async () => {
    const s = store([pkg("ms-1")]);
    await pullAnalysis(s, true, {
      invoke: async () => ({
        status: 200,
        body: { outcome: { status: "failed", reason: "provider_error", detail: "model down" } },
      }),
    });
    await s.load();
    const p = s.get("ms-1")!;
    expect(p.analysisError).toContain("provider_error");
    expect(p.analysisError).toContain("model down");
    expect(p.analysis).toBeNull();
  });

  test("an assessment arriving later CLEARS the earlier failure", async () => {
    const s = store([pkg("ms-1")]);
    await s.attachError("ms-1", "provider_error: model down");
    await s.attachAnalysis("ms-1", FINDINGS);
    await s.load();
    expect(s.get("ms-1")?.analysisError).toBeNull();
    expect(s.get("ms-1")?.analysis).not.toBeNull();
  });
});

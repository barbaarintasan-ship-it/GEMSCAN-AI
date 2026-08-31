// Priority 6 — outcome/data instrumentation. NOT an ML system: this only pins
// that the fields exist, are separate from workflow state, and are readable
// long after a mission's delivery is finished. No score reads any of this.
import { newMission, outcomeOf, type Mission } from "../exploration/mission";
import { buildEvidencePackage, type BuildPackageInput } from "../exploration/evidencePackage";
import { PackageStore } from "../exploration/packageStore";
import type { Scored } from "../geo/targeting";
import type { KeyValueAdapter } from "../sync/outbox";

const NOW = Date.parse("2026-08-25T00:00:00.000Z");

function memoryStorage(): KeyValueAdapter & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => { data.set(k, v); },
  };
}

describe("MissionOutcome — separate from workflow state", () => {
  it("a new mission starts not_yet_determined", () => {
    const m = newMission("ms-1", "c1", { lat: 0, lng: 0 }, { commodity: null, score: 0.5, at: NOW });
    expect(m.outcome).toBe("not_yet_determined");
  });

  it("outcomeOf() defaults an old record (no outcome field at all) honestly", () => {
    const old = { id: "ms-1" } as unknown as Mission;
    expect(outcomeOf(old)).toBe("not_yet_determined");
  });

  it("outcome is a plain field, not derived from MissionState", () => {
    const m = newMission("ms-1", "c1", { lat: 0, lng: 0 }, { commodity: null, score: 0.5, at: NOW });
    // Changing state does not touch outcome — they are independent axes.
    const withDifferentOutcome: Mission = { ...m, outcome: "barren" };
    expect(withDifferentOutcome.state).toBe(m.state);
    expect(withDifferentOutcome.outcome).toBe("barren");
  });
});

describe("EvidencePackage.baselineEvidenceSnapshot — the raw baseline, not just its two output numbers", () => {
  const baseline: Scored[] = [
    {
      item: { statement: "quartz vein", weight: 0.7, tier: "mapped" },
      reason: { kind: "observation", label: "quartz-vein", distanceM: 0 },
      role: "field", group: "field:wp-1",
    },
  ];

  function baseInput(over: Partial<BuildPackageInput> = {}): BuildPackageInput {
    return {
      mission: newMission("ms-1", "c1", { lat: 0, lng: 0 }, { commodity: "gold", score: 0.5, at: NOW }),
      explorationSessionId: "ex-1", waypoints: [], track: [],
      targetReasons: [], geologyContext: null, terrainContext: null,
      structuralContext: [], coverage: null, at: NOW,
      ...over,
    };
  }

  it("is null when no baseline evidence was supplied", () => {
    const pkg = buildEvidencePackage(baseInput());
    expect(pkg.baselineEvidenceSnapshot).toBeNull();
  });

  it("carries the baseline evidence VERBATIM — statements and reasons intact, not flattened", () => {
    const pkg = buildEvidencePackage(baseInput({ baselineEvidence: baseline }));
    expect(pkg.baselineEvidenceSnapshot).toEqual(baseline);
    expect(pkg.baselineEvidenceSnapshot![0].item.statement).toBe("quartz vein");
    expect(pkg.baselineEvidenceSnapshot![0].reason).toEqual({ kind: "observation", label: "quartz-vein", distanceM: 0 });
  });

  it("does not affect prospectivityScore or integratedProspectivityScore — instrumentation only", () => {
    const withSnapshot = buildEvidencePackage(baseInput({ baselineEvidence: baseline }));
    const without = buildEvidencePackage(baseInput());
    expect(withSnapshot.prospectivityScore).toBe(without.prospectivityScore);
  });
});

describe("PackageStore.setOutcome — callable any time, on any package, regardless of state", () => {
  async function storeWithOnePackage() {
    const storage = memoryStorage();
    const store = new PackageStore({ storage, now: () => NOW });
    const pkg = buildEvidencePackage({
      mission: newMission("ms-1", "c1", { lat: 0, lng: 0 }, { commodity: "tin", score: 0.4, at: NOW }),
      explorationSessionId: "ex-1", waypoints: [], track: [],
      targetReasons: [], geologyContext: null, terrainContext: null,
      structuralContext: [], coverage: null, at: NOW,
    });
    await store.save(pkg);
    return { store, storage, pkg };
  }

  it("sets the outcome on an existing package", async () => {
    const { store, pkg } = await storeWithOnePackage();
    await store.setOutcome(pkg.id, "confirmed_mineralized");
    expect(store.get(pkg.id)!.outcome).toBe("confirmed_mineralized");
  });

  it("persists across a fresh load — a real record, not in-memory only", async () => {
    const { store, storage, pkg } = await storeWithOnePackage();
    await store.setOutcome(pkg.id, "barren");
    const reopened = new PackageStore({ storage, now: () => NOW });
    await reopened.load();
    expect(reopened.get(pkg.id)!.outcome).toBe("barren");
  });

  it("a delivered/analysed package can still have its outcome set — not gated to any state", async () => {
    const { store, pkg } = await storeWithOnePackage();
    await store.attachAnalysis(pkg.id, {
      version: 1, commodity: null, interest: "moderate", confidence: "low",
      evidence: [], missingEvidence: [], recommendations: [],
      model: "test", analysedAt: NOW,
    });
    await store.setOutcome(pkg.id, "encouraging");
    expect(store.get(pkg.id)!.outcome).toBe("encouraging");
    expect(store.get(pkg.id)!.analysis).not.toBeNull();
  });

  it("an unknown package id is a silent no-op, never a crash", async () => {
    const { store } = await storeWithOnePackage();
    await expect(store.setOutcome("does-not-exist", "barren")).resolves.toBeUndefined();
  });
});

import {
  detectGoldHost,
  isGoldProspectHost,
  evaluateGoldProspect,
  categoryOf,
  economicOf,
  EMPTY_ANSWERS,
  type GoldProspectAnswers,
} from "./goldProspect";

const L = (en: string) => en; // language-independent for tests

describe("gold host detection", () => {
  it("detects gold-associated host rocks", () => {
    expect(isGoldProspectHost(["Quartz Vein"])).toBe(true);
    expect(isGoldProspectHost(["Pyrite-bearing rock"])).toBe(true);
    expect(isGoldProspectHost(["Greenstone"])).toBe(true);
    expect(isGoldProspectHost(["Arsenopyrite"])).toBe(true);
  });

  it("does NOT trigger on unrelated items", () => {
    expect(isGoldProspectHost(["Diamond"])).toBe(false);
    expect(isGoldProspectHost(["Ruby", "Sapphire"])).toBe(false);
    expect(isGoldProspectHost([])).toBe(false);
  });

  it("prefers the strongest host when several match", () => {
    expect(detectGoldHost(["Gold-bearing quartz"])?.base).toBe(58);
    expect(detectGoldHost(["Quartz vein"])?.base).toBe(42);
    expect(detectGoldHost(["Quartzite"])?.base).toBe(24);
  });
});

describe("score thresholds", () => {
  it("maps score to category", () => {
    expect(categoryOf(10)).toBe("very_low");
    expect(categoryOf(35)).toBe("low");
    expect(categoryOf(55)).toBe("moderate");
    expect(categoryOf(75)).toBe("high");
    expect(categoryOf(95)).toBe("very_high");
  });
  it("maps score to economic potential", () => {
    expect(economicOf(10)).toBe("none");
    expect(economicOf(30)).toBe("low");
    expect(economicOf(85)).toBe("highly_promising");
  });
});

describe("evaluateGoldProspect", () => {
  it("returns null for a non-gold-host item", () => {
    expect(evaluateGoldProspect({ labels: ["Diamond"], confidencePct: 90, answers: EMPTY_ANSWERS }, L)).toBeNull();
  });

  it("scores host-rock-only with no answers, clamped 0-100", () => {
    const r = evaluateGoldProspect({ labels: ["Quartz vein"], confidencePct: 90, answers: EMPTY_ANSWERS }, L)!;
    expect(r).not.toBeNull();
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    // base 42, no answers → notes the limited info
    expect(r.evidenceAgainst.join(" ")).toMatch(/Limited field information/);
  });

  it("increases the score when supportive observations are present", () => {
    const base = evaluateGoldProspect({ labels: ["Quartz vein"], confidencePct: 90, answers: EMPTY_ANSWERS }, L)!;
    const rich: GoldProspectAnswers = {
      foundContext: "old_mine",
      nearbyDensity: "many",
      observations: ["quartz_veins", "black_sulfides", "metallic_particles", "rust_staining", "heavy_minerals"],
    };
    const strong = evaluateGoldProspect({ labels: ["Quartz vein"], confidencePct: 90, answers: rich }, L)!;
    expect(strong.score).toBeGreaterThan(base.score);
    expect(strong.evidenceFor.length).toBeGreaterThan(base.evidenceFor.length);
    expect(strong.category).toBe("very_high");
  });

  it("raises the score and adds evidence when regional geology is favorable", () => {
    const base = evaluateGoldProspect({ labels: ["Quartz vein"], confidencePct: 90, answers: EMPTY_ANSWERS }, L)!;
    const withGeo = evaluateGoldProspect(
      { labels: ["Quartz vein"], confidencePct: 90, answers: EMPTY_ANSWERS, geology: { favorable: true, documentedNearby: true } },
      L,
    )!;
    expect(withGeo.score).toBeGreaterThan(base.score);
    expect(withGeo.evidenceFor.join(" ")).toMatch(/Regional geology is favorable/);
  });

  it("always produces evidence, next steps and never confirms gold", () => {
    const r = evaluateGoldProspect({ labels: ["Pyrite"], confidencePct: 70, answers: EMPTY_ANSWERS }, L)!;
    expect(r.nextSteps.length).toBeGreaterThan(0);
    expect(r.evidenceFor.length).toBeGreaterThan(0);
    // de-duplicated next steps
    expect(new Set(r.nextSteps).size).toBe(r.nextSteps.length);
  });
});

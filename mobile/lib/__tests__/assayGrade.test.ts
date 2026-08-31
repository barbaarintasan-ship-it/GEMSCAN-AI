// Priority 2 — grade-aware assay interpretation. Pins the bands, the honest
// "unclassified" fallback, and every required edge case.
import { classifyGrade, hasGradeConvention, GRADE_BAND_FACTOR } from "../geo/assayGrade";

describe("classifyGrade — gold (Au, g/t)", () => {
  it("bands ascend from trace to exceptional", () => {
    expect(classifyGrade("Au", 0.02, "g/t")).toBe("trace");
    expect(classifyGrade("Au", 0.5, "g/t")).toBe("low");
    expect(classifyGrade("Au", 3, "g/t")).toBe("moderate");
    expect(classifyGrade("Au", 10, "g/t")).toBe("high");
    expect(classifyGrade("Au", 25, "g/t")).toBe("exceptional");
  });

  it("accepts common aliases", () => {
    expect(classifyGrade("gold", 3, "g/t")).toBe("moderate");
  });
});

describe("classifyGrade — tin (Sn, %)", () => {
  it("bands ascend from trace to exceptional", () => {
    expect(classifyGrade("Sn", 0.005, "%")).toBe("trace");
    expect(classifyGrade("Sn", 0.05, "%")).toBe("low");
    expect(classifyGrade("Sn", 0.3, "%")).toBe("moderate");
    expect(classifyGrade("Sn", 0.8, "%")).toBe("high");
    expect(classifyGrade("Sn", 2, "%")).toBe("exceptional");
  });

  it("accepts common aliases", () => {
    expect(classifyGrade("tin", 0.3, "%")).toBe("moderate");
  });
});

describe("classifyGrade — honest fallback to unclassified", () => {
  it("an element with no convention at all", () => {
    expect(classifyGrade("Cu", 5, "%")).toBe("unclassified");
  });

  it("the right element, wrong unit — no silent unit conversion", () => {
    expect(classifyGrade("Sn", 5, "g/t")).toBe("unclassified");
    expect(classifyGrade("Au", 5, "%")).toBe("unclassified");
  });

  it("missing/invalid grade", () => {
    expect(classifyGrade("Au", NaN, "g/t")).toBe("unclassified");
    expect(classifyGrade("Au", Infinity, "g/t")).toBe("unclassified");
  });

  it("negative grade — a lab does not report negative concentration", () => {
    expect(classifyGrade("Au", -1, "g/t")).toBe("unclassified");
  });

  it("zero is a real, classifiable reading (trace), not invalid", () => {
    expect(classifyGrade("Au", 0, "g/t")).toBe("trace");
  });
});

describe("hasGradeConvention", () => {
  it("true for gold and tin", () => {
    expect(hasGradeConvention("Au")).toBe(true);
    expect(hasGradeConvention("Sn")).toBe(true);
  });

  it("false for anything else", () => {
    expect(hasGradeConvention("Cu")).toBe(false);
    expect(hasGradeConvention("Pb")).toBe(false);
  });
});

describe("GRADE_BAND_FACTOR — bounded to the SAME [0.5, 1.5] range commodityModel.ts uses", () => {
  it("every factor is within bounds, moderate is neutral", () => {
    for (const f of Object.values(GRADE_BAND_FACTOR)) {
      expect(f).toBeGreaterThanOrEqual(0.5);
      expect(f).toBeLessThanOrEqual(1.5);
    }
    expect(GRADE_BAND_FACTOR.moderate).toBe(1.0);
    expect(GRADE_BAND_FACTOR.unclassified).toBe(1.0);
  });

  it("bands are strictly ordered: trace < low < moderate < high < exceptional", () => {
    expect(GRADE_BAND_FACTOR.trace).toBeLessThan(GRADE_BAND_FACTOR.low);
    expect(GRADE_BAND_FACTOR.low).toBeLessThan(GRADE_BAND_FACTOR.moderate);
    expect(GRADE_BAND_FACTOR.moderate).toBeLessThan(GRADE_BAND_FACTOR.high);
    expect(GRADE_BAND_FACTOR.high).toBeLessThan(GRADE_BAND_FACTOR.exceptional);
  });
});

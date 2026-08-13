// How the receiver's accuracy is WRITTEN — never how it is measured.
//
// The field build printed "GPS accuracy: 17.799999237060547 m". Android reports
// accuracy as a float32; the nearest float32 to 17.8 is 17.799999237060547, and
// the panel printed the double expansion of it. Sixteen of those digits came from
// the number format, not from the satellites.
//
// The standing instruction on this screen is that accuracy is never rounded — a
// ±1.5 m fix must read ±1.5 m, not ±2 m. So the rule below keeps every digit the
// receiver could have meant and drops only the ones it cannot have: recovering
// 17.8 from its own float32 expansion is the opposite of rounding it away.
import { formatAccuracyM } from "../geo/fixQuality";

describe("formatAccuracyM", () => {
  test("the exact float32 that started this reads as the metre it means", () => {
    expect(formatAccuracyM(17.799999237060547)).toBe("±17.8 m");
    // And that IS the float32 of 17.8 — the digits were never information.
    expect(Math.fround(17.8)).toBe(17.799999237060547);
  });

  test("a precise fix keeps its precision — the whole point of the instruction", () => {
    expect(formatAccuracyM(1.5)).toBe("±1.5 m");
    expect(formatAccuracyM(Math.fround(1.5))).toBe("±1.5 m");
    expect(formatAccuracyM(3.2)).toBe("±3.2 m");
  });

  test("sub-metre keeps two decimals, where the second one is real", () => {
    expect(formatAccuracyM(0.75)).toBe("±0.75 m");
    expect(formatAccuracyM(0.5)).toBe("±0.5 m");
  });

  test("a whole number is not padded with a fake decimal", () => {
    expect(formatAccuracyM(18)).toBe("±18 m");
    expect(formatAccuracyM(Math.fround(18))).toBe("±18 m");
  });

  test("nothing is invented when nothing was reported", () => {
    expect(formatAccuracyM(null)).toBe("not reported");
    expect(formatAccuracyM(undefined)).toBe("not reported");
    expect(formatAccuracyM(Number.NaN)).toBe("not reported");
    expect(formatAccuracyM(Number.POSITIVE_INFINITY)).toBe("not reported");
  });

  test("a coarse fix is not dressed up as a fine one", () => {
    // 847 m is a cell-tower fix. It must read as what it is.
    expect(formatAccuracyM(847.3200073242188)).toBe("±847.3 m");
  });

  test("the formatter never alters the value it is given", () => {
    // Display only. Distances, arrival radii and stored records use the full
    // double, and this function is not in any of those paths.
    const raw = 17.799999237060547;
    formatAccuracyM(raw);
    expect(raw).toBe(17.799999237060547);
  });
});

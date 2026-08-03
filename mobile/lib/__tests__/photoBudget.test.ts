// How large a photo may be when it leaves the phone.
//
// These exist because the first version of this policy was written inline, had
// no tests, and was wrong: it resized by WIDTH, so a portrait outcrop shot —
// most of them — kept a long edge far above the limit. The bug that started all
// of this was photo size, so the sizing rule is the last place to be guessing.
import {
  resizeTargetFor, estimateJpegBytes, UPLOAD_MAX_EDGE_PX,
} from "../photoBudget";

describe("the LONG edge is what gets capped", () => {
  test("a landscape frame is scaled by its width", () => {
    const t = resizeTargetFor(4000, 3000)!;
    expect(Math.max(t.width, t.height)).toBe(UPLOAD_MAX_EDGE_PX);
    expect(t.width).toBe(2048);
    expect(t.height).toBe(1536);
  });

  test("a PORTRAIT frame is scaled by its HEIGHT — the case that was wrong", () => {
    const t = resizeTargetFor(3000, 4000)!;
    // Resizing by width would have produced 2048x2731 here: 1.8x the pixels,
    // and the reason a "2048 px" cap was not actually capping anything.
    expect(Math.max(t.width, t.height)).toBe(UPLOAD_MAX_EDGE_PX);
    expect(t.height).toBe(2048);
    expect(t.width).toBe(1536);
  });

  test("aspect ratio is preserved either way", () => {
    for (const [w, h] of [[4000, 3000], [3000, 4000], [4032, 2268], [2268, 4032]]) {
      const t = resizeTargetFor(w, h)!;
      expect(t.width / t.height).toBeCloseTo(w / h, 2);
    }
  });

  test("a square frame caps both edges", () => {
    const t = resizeTargetFor(3000, 3000)!;
    expect(t).toEqual({ width: 2048, height: 2048 });
  });
});

describe("photos already small enough are left alone", () => {
  test("exactly at the limit is not re-encoded", () => {
    expect(resizeTargetFor(2048, 1200)).toBeNull();
  });

  test("well under the limit is not re-encoded", () => {
    // Re-encoding a small photo only loses detail and saves nothing.
    expect(resizeTargetFor(900, 1200)).toBeNull();
  });
});

describe("nonsense dimensions do not produce a nonsense image", () => {
  test.each([
    [0, 1000], [1000, 0], [-1, 100], [NaN, 100], [Infinity, 100],
  ])("(%s x %s) yields no resize, so the original is sent as-is", (w, h) => {
    expect(resizeTargetFor(w as number, h as number)).toBeNull();
  });

  test("an extreme panorama keeps at least one pixel on the short edge", () => {
    const t = resizeTargetFor(40000, 6)!;
    expect(t.width).toBe(UPLOAD_MAX_EDGE_PX);
    expect(t.height).toBeGreaterThanOrEqual(1);
  });
});

describe("the resulting photos are inside the analysis budget", () => {
  // The server skips any single image whose base64 exceeds 8 MB, which is about
  // 6 MB on disk, and spends a 12 MB total budget. A capped photo has to sit far
  // enough below that for a whole sample to fit.
  test("a capped photo is roughly half a megabyte, not seven", () => {
    const t = resizeTargetFor(4000, 3000)!;
    const bytes = estimateJpegBytes(t.width, t.height);
    expect(bytes).toBeLessThan(1_000_000);
  });

  test("eight capped photos still fit the whole vision budget", () => {
    const t = resizeTargetFor(3000, 4000)!;
    const encoded = estimateJpegBytes(t.width, t.height) * (4 / 3); // base64
    expect(encoded * 8).toBeLessThan(12 * 1024 * 1024);
  });

  test("the failing production samples would now pass", () => {
    // Qarka Qardhl shipped 11 photos at 6.94 MB. Same photos, capped:
    const t = resizeTargetFor(4000, 3000)!;
    const perPhotoEncoded = estimateJpegBytes(t.width, t.height) * (4 / 3);
    expect(perPhotoEncoded).toBeLessThan(8 * 1024 * 1024);   // under the single-image limit
  });
});

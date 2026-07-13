// Unit tests for the pure gemstone object-detection gate (lib/gemstoneDetector.ts).
// These exercise the "is a gemstone-like object being held in front of the
// camera?" heuristic directly with synthetic RGBA buffers — no camera, GL, or
// React involved. This is the requirement-8 rejection contract: an empty /
// uniform scene must NOT pass the gate, while a distinct, structured, saturated,
// sparkly centre region (a stand-in for a held stone) must.
import {
  computeDetectionFromPixels,
  scanStatusForProgress,
  SCAN_STATUS_I18N_KEY,
  GEM_PRESENCE_THRESHOLD,
  REQUIRED_DETECTION_FRAMES,
} from "../gemstoneDetector";

const SIZE = 96;

// Build a size×size RGBA buffer from a per-pixel colour function.
function makeFrame(
  size: number,
  color: (x: number, y: number) => [number, number, number],
): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const [r, g, b] = color(x, y);
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = 255;
    }
  }
  return px;
}

// A held stone: distinct, saturated, structured (checker-textured) blob in the
// centre third over a flat neutral-grey background (the "surface").
function gemLikeColor(x: number, y: number): [number, number, number] {
  // A held stone fills most of the frame, leaving only the outer ~22% as
  // visible surface/background.
  const lo = SIZE * 0.22;
  const hi = SIZE * 0.78;
  const inCenter = x >= lo && x < hi && y >= lo && y < hi;
  if (!inCenter) return [128, 128, 128]; // flat grey surface (border/background)
  // Saturated blue-green with a fine checker for edge/facet structure and an
  // occasional specular pin-point.
  const checker = (Math.floor(x / 2) + Math.floor(y / 2)) % 2 === 0;
  if ((x % 9 === 0 && y % 9 === 0)) return [250, 250, 250]; // specular sparkle
  return checker ? [20, 90, 200] : [10, 160, 120];
}

describe("computeDetectionFromPixels", () => {
  it("rejects a uniform/empty scene (no held object)", () => {
    const px = makeFrame(SIZE, () => [130, 130, 130]);
    const det = computeDetectionFromPixels(px, SIZE);
    expect(det.present).toBe(false);
    expect(det.objectness).toBeLessThan(GEM_PRESENCE_THRESHOLD);
    expect(det.box).toBeNull();
    expect(det.signals.coverage).toBeCloseTo(0, 5);
  });

  it("rejects gentle background noise that has no distinct centre region", () => {
    // Low-amplitude gradient across the whole frame: no centre/border contrast.
    const px = makeFrame(SIZE, (x) => {
      const v = 120 + Math.round((x / SIZE) * 8);
      return [v, v, v];
    });
    const det = computeDetectionFromPixels(px, SIZE);
    expect(det.present).toBe(false);
    expect(det.objectness).toBeLessThan(GEM_PRESENCE_THRESHOLD);
  });

  it("detects a distinct, structured, saturated centre object", () => {
    const px = makeFrame(SIZE, gemLikeColor);
    const det = computeDetectionFromPixels(px, SIZE);
    expect(det.present).toBe(true);
    expect(det.objectness).toBeGreaterThanOrEqual(GEM_PRESENCE_THRESHOLD);
    expect(det.box).not.toBeNull();
  });

  it("derives a bounding box roughly over the centre object", () => {
    const px = makeFrame(SIZE, gemLikeColor);
    const det = computeDetectionFromPixels(px, SIZE);
    expect(det.box).not.toBeNull();
    const box = det.box!;
    // The object sits in the centre third — its box should start after the
    // top-left third and not span the whole frame.
    expect(box.x).toBeGreaterThan(0.15);
    expect(box.y).toBeGreaterThan(0.15);
    expect(box.width).toBeLessThan(0.85);
    expect(box.height).toBeLessThan(0.85);
  });

  it("returns clamped [0,1] signals", () => {
    const px = makeFrame(SIZE, gemLikeColor);
    const det = computeDetectionFromPixels(px, SIZE);
    for (const v of Object.values(det.signals)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(det.objectness).toBeGreaterThanOrEqual(0);
    expect(det.objectness).toBeLessThanOrEqual(1);
  });
});

describe("scanStatusForProgress", () => {
  it("narrates capture → surface → AI as evidence accumulates", () => {
    expect(scanStatusForProgress(0)).toBe("capturing");
    expect(scanStatusForProgress(0.39)).toBe("capturing");
    expect(scanStatusForProgress(0.4)).toBe("analyzingSurface");
    expect(scanStatusForProgress(0.74)).toBe("analyzingSurface");
    expect(scanStatusForProgress(0.75)).toBe("preparingAi");
    expect(scanStatusForProgress(1)).toBe("preparingAi");
  });

  it("maps every status to an i18n key under scanner.*", () => {
    for (const key of Object.values(SCAN_STATUS_I18N_KEY)) {
      expect(key.startsWith("scanner.")).toBe(true);
    }
  });
});

describe("gate constants", () => {
  it("uses a sane presence threshold and debounce", () => {
    expect(GEM_PRESENCE_THRESHOLD).toBeGreaterThan(0);
    expect(GEM_PRESENCE_THRESHOLD).toBeLessThan(1);
    expect(REQUIRED_DETECTION_FRAMES).toBeGreaterThanOrEqual(2);
  });
});

// Unit tests for the pure quality-scoring math in ImageProcessorGL.tsx
// (Stage 1 automatic blur/exposure validation). The component itself needs a
// mounted GLView to obtain a WebGL context, so we only import and exercise
// the pure `computeQualityFromPixels` function here — everything GL/native
// is mocked out since it's irrelevant to this math. Jest hoists jest.mock()
// calls above imports regardless of source order, so declaring the mocks
// after the import is equivalent but keeps import/first lint rules happy.
import { computeQualityFromPixels } from "../ImageProcessorGL";

jest.mock("expo-gl", () => ({ GLView: () => null }));
jest.mock("expo-image-manipulator", () => ({
  manipulateAsync: jest.fn(),
  SaveFormat: { PNG: "png" },
}));

const SIZE = 8;

function solidColorPixels(r: number, g: number, b: number): Uint8Array {
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) {
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = 255;
  }
  return pixels;
}

function checkerboardPixels(): Uint8Array {
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      const value = (x + y) % 2 === 0 ? 255 : 0;
      pixels[i * 4] = value;
      pixels[i * 4 + 1] = value;
      pixels[i * 4 + 2] = value;
      pixels[i * 4 + 3] = 255;
    }
  }
  return pixels;
}

describe("computeQualityFromPixels", () => {
  it("flags a perfectly flat (solid color) image as blurry", () => {
    // A uniform image has zero Laplacian response everywhere -> zero variance
    // -> zero sharpness, which must be below the blur threshold.
    const result = computeQualityFromPixels(solidColorPixels(128, 128, 128), SIZE);
    expect(result.blurry).toBe(true);
    expect(result.sharpness).toBe(0);
  });

  it("does not flag a high-frequency checkerboard image as blurry", () => {
    const result = computeQualityFromPixels(checkerboardPixels(), SIZE);
    expect(result.blurry).toBe(false);
    expect(result.sharpness).toBeGreaterThan(0);
  });

  it("flags a dark solid image as lowLight and not overexposed", () => {
    const result = computeQualityFromPixels(solidColorPixels(10, 10, 10), SIZE);
    expect(result.lowLight).toBe(true);
    expect(result.overexposed).toBe(false);
    expect(result.meanBrightness).toBeCloseTo(10 / 255, 2);
  });

  it("flags a near-white solid image as overexposed and not lowLight", () => {
    const result = computeQualityFromPixels(solidColorPixels(250, 250, 250), SIZE);
    expect(result.overexposed).toBe(true);
    expect(result.lowLight).toBe(false);
  });

  it("does not flag a mid-brightness image as either lowLight or overexposed", () => {
    const result = computeQualityFromPixels(solidColorPixels(128, 128, 128), SIZE);
    expect(result.lowLight).toBe(false);
    expect(result.overexposed).toBe(false);
  });

  it("scores a flat, well-lit image as reduced quality only from blur", () => {
    // Uniform + well-exposed -> blurry (0.5 penalty) but not dark/bright
    // (no 0.35 penalty) -> qualityScore should land at 0.5.
    const result = computeQualityFromPixels(solidColorPixels(128, 128, 128), SIZE);
    expect(result.qualityScore).toBeCloseTo(0.5, 5);
  });

  it("scores a sharp, dark image as reduced quality only from exposure", () => {
    const result = computeQualityFromPixels(checkerboardPixels(), SIZE);
    // checkerboard alternates 0/255 -> mean brightness 0.5, not dark/bright,
    // and it's sharp, so nothing should be penalized.
    expect(result.blurry).toBe(false);
    expect(result.lowLight).toBe(false);
    expect(result.overexposed).toBe(false);
    expect(result.qualityScore).toBe(1);
  });

  it("never produces a qualityScore outside [0, 1]", () => {
    for (const pixels of [
      solidColorPixels(0, 0, 0),
      solidColorPixels(255, 255, 255),
      checkerboardPixels(),
    ]) {
      const result = computeQualityFromPixels(pixels, SIZE);
      expect(result.qualityScore).toBeGreaterThanOrEqual(0);
      expect(result.qualityScore).toBeLessThanOrEqual(1);
    }
  });
});

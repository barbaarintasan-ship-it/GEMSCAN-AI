// On-device gemstone OBJECT DETECTION (pre-scan gate) — the pure,
// framework-free heuristic that answers a single question every live frame:
//
//   "Is there a distinct, gemstone-LIKE object being held in front of the
//    camera right now — or is the camera just pointed at an empty surface?"
//
// This is deliberately a *presence / localization* gate, not a final identity
// call. The definitive "is this actually a gemstone (vs a rock / metal / plastic
// bead)" verdict is the job of the cloud ensemble in orchestrate-scan, which
// returns low / insufficient confidence for non-gemstones. This gate exists so
// the scanner does not start capturing angles or spending cloud calls on an
// empty scene, and so we can honestly tell the user "No gemstone detected.
// Please place a gemstone in front of the camera."
//
// Why heuristic and not a TFLite model: lib/onDeviceDetection.ts is wired for a
// trained YOLO detector, but no model artifact is bundled yet (both of its
// functions fail-soft to null). Until that model exists, this pixel heuristic
// gives a real, testable object-presence signal from the same small RGBA frame
// the quality check already reads — no extra capture, no network, no GPU beyond
// the single readPixels the live loop already performs.
//
// The heuristic combines four cues that separate "a held specimen" from "an
// empty background":
//   1. centre/border contrast — a held object differs from the surface behind
//      it (an empty, uniform scene has ~zero centre/border difference);
//   2. structure / edge density in the centre — facets, inclusions and edges
//      produce local gradients a blank surface lacks;
//   3. colourfulness (saturation) — many gems carry saturated colour;
//   4. specular highlights — the bright pin-point sparkle characteristic of a
//      faceted or polished stone.
// It also derives a bounding box from where the centre actually deviates from
// the background, which the HUD animates as the "detected object" frame.

export type FrameRGBA = { pixels: Uint8Array; size: number };

export type DetectionSignals = {
  centerBorderContrast: number; // 0-1, how different the centre is from the border
  edgeDensity: number; // 0-1, fraction of structured (high-gradient) centre pixels
  saturation: number; // 0-1, mean centre colour saturation
  specular: number; // 0-1, fraction of bright specular (sparkle) centre pixels
  coverage: number; // 0-1, fraction of the frame the object appears to fill
};

export type DetectionBox = {
  x: number; // normalized 0-1, top-left
  y: number;
  width: number;
  height: number;
};

export type GemstoneDetection = {
  present: boolean;
  // Object-presence likelihood (0-1). NOT an identification confidence — it is
  // only "how gemstone-like the thing in frame looks" for gating purposes.
  objectness: number;
  box: DetectionBox | null;
  signals: DetectionSignals;
};

// Objectness at/above which we treat a "possible gemstone-like object" as
// present. Tuned so an empty/uniform scene stays well below it while a held,
// structured, distinct object clears it.
export const GEM_PRESENCE_THRESHOLD = 0.42;

// Consecutive frames a possible gemstone must be seen before the scanner leaves
// the detection phase — debounces a single lucky/erratic frame.
export const REQUIRED_DETECTION_FRAMES = 3;

// A centre pixel counts toward "object" (vs background) when its luminance or
// colour differs from the border mean by at least this much (0-1 units).
const OBJECT_DEVIATION = 0.14;
// Local-gradient magnitude above which a centre pixel is "structured" (an edge
// / facet / inclusion) rather than flat.
const EDGE_GRADIENT_MIN = 0.08;
// Luminance above which a centre pixel is treated as a specular highlight.
const SPECULAR_LUMA_MIN = 0.82;

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function luma(r: number, g: number, b: number): number {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// HSV-style saturation from 0-255 RGB, returned 0-1.
function saturationOf(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max <= 0) return 0;
  return (max - min) / max;
}

// Core pure detector: (RGBA pixels of a small square frame) -> detection.
// `size` is the side length in pixels (e.g. 96). Exported for direct unit
// testing with synthetic buffers.
export function computeDetectionFromPixels(pixels: Uint8Array, size: number): GemstoneDetection {
  // Border ring = outer ~18% margin on every side; centre = the rest. The
  // border approximates "the surface/background", the centre "where a held
  // specimen would be".
  const margin = Math.max(1, Math.round(size * 0.18));
  const inMin = margin;
  const inMax = size - margin - 1;

  // 1) Border background statistics.
  let bR = 0;
  let bG = 0;
  let bB = 0;
  let bLumaSum = 0;
  let borderCount = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const border = x < inMin || x > inMax || y < inMin || y > inMax;
      if (!border) continue;
      const i = (y * size + x) * 4;
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      bR += r;
      bG += g;
      bB += b;
      bLumaSum += luma(r, g, b);
      borderCount++;
    }
  }
  if (borderCount === 0) {
    return emptyDetection();
  }
  const borderR = bR / borderCount;
  const borderG = bG / borderCount;
  const borderB = bB / borderCount;
  const borderLuma = bLumaSum / borderCount;

  // 2) Walk the centre: build an "object mask" (pixels that deviate from the
  // background), accumulate structure / saturation / specular, and track the
  // object's bounding box.
  let centerCount = 0;
  let objectPixels = 0;
  let structuredPixels = 0;
  let specularPixels = 0;
  let satSum = 0;
  let minX = size;
  let minY = size;
  let maxX = 0;
  let maxY = 0;

  for (let y = inMin; y <= inMax; y++) {
    for (let x = inMin; x <= inMax; x++) {
      const i = (y * size + x) * 4;
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      const l = luma(r, g, b);
      centerCount++;
      satSum += saturationOf(r, g, b);

      // Deviation from background: luminance delta + normalized colour delta.
      const colorDelta =
        (Math.abs(r - borderR) + Math.abs(g - borderG) + Math.abs(b - borderB)) / (3 * 255);
      const deviation = Math.max(Math.abs(l - borderLuma), colorDelta);
      if (deviation >= OBJECT_DEVIATION) {
        objectPixels++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }

      if (l >= SPECULAR_LUMA_MIN) specularPixels++;

      // Local gradient (right + down neighbours) for structure/edge density.
      if (x < inMax && y < inMax) {
        const iR = (y * size + (x + 1)) * 4;
        const iD = ((y + 1) * size + x) * 4;
        const gx = Math.abs(l - luma(pixels[iR], pixels[iR + 1], pixels[iR + 2]));
        const gy = Math.abs(l - luma(pixels[iD], pixels[iD + 1], pixels[iD + 2]));
        if (Math.max(gx, gy) >= EDGE_GRADIENT_MIN) structuredPixels++;
      }
    }
  }

  if (centerCount === 0) {
    return emptyDetection();
  }

  const coverage = clamp01(objectPixels / centerCount);
  const edgeDensity = clamp01(structuredPixels / centerCount);
  const saturation = clamp01(satSum / centerCount);
  const specular = clamp01(specularPixels / centerCount);

  // Centre/border contrast: mean object coverage weighted by how strongly the
  // object region stands out. Coverage already encodes "distinct region
  // present"; scale so a modest but real object registers.
  const centerBorderContrast = clamp01(coverage * 1.4);

  // Objectness blend. Presence of a distinct centre region dominates (an empty
  // scene has ~0 here and cannot pass on sparkle alone). Structure adds
  // confidence; saturation + specular are gem-like bonuses that lift a genuine
  // stone above a plain distinct blob but can't manufacture presence by
  // themselves.
  const objectness = clamp01(
    0.5 * centerBorderContrast +
      0.25 * edgeDensity +
      0.15 * saturation +
      0.1 * Math.min(1, specular * 6),
  );

  const box: DetectionBox | null =
    objectPixels > 0 && maxX >= minX && maxY >= minY
      ? {
          x: clamp01(minX / size),
          y: clamp01(minY / size),
          width: clamp01((maxX - minX + 1) / size),
          height: clamp01((maxY - minY + 1) / size),
        }
      : null;

  return {
    present: objectness >= GEM_PRESENCE_THRESHOLD && box !== null,
    objectness,
    box,
    signals: { centerBorderContrast, edgeDensity, saturation, specular, coverage },
  };
}

function emptyDetection(): GemstoneDetection {
  return {
    present: false,
    objectness: 0,
    box: null,
    signals: {
      centerBorderContrast: 0,
      edgeDensity: 0,
      saturation: 0,
      specular: 0,
      coverage: 0,
    },
  };
}

// ── Scanner status model ─────────────────────────────────────────────────────
// The professional-scanner HUD walks through these phases. Kept here (pure, no
// React) so the copy is shared and testable and the live screen just maps the
// current phase to a translation key.
export type ScanStatus =
  | "detecting"
  | "detected"
  | "capturing"
  | "analyzingSurface"
  | "preparingAi";

// i18n keys (see locales/*.json → "scanner"). The live screen resolves these
// with react-i18next so the scanner speaks the user's chosen language.
export const SCAN_STATUS_I18N_KEY: Record<ScanStatus, string> = {
  detecting: "scanner.detecting",
  detected: "scanner.detected",
  capturing: "scanner.capturing",
  analyzingSurface: "scanner.analyzingSurface",
  preparingAi: "scanner.preparingAi",
};

// Maps how far through evidence collection we are to the right in-scan status
// message, so the HUD narrates progress ("Capturing angles…" → "Analysing
// surface…" → "Preparing AI analysis…") rather than sitting on one line.
export function scanStatusForProgress(evidence: number): ScanStatus {
  if (evidence >= 0.75) return "preparingAi";
  if (evidence >= 0.4) return "analyzingSurface";
  return "capturing";
}

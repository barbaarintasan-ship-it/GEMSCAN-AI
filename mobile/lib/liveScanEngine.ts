// Live Scan engine — the pure, framework-free brain of the real-time scanner
// (app/(app)/scan/live.tsx).
//
// It consumes a stream of on-device frame-quality assessments (the SAME
// QualityAssessment shape produced by components/ImageProcessorGL.assessQuality,
// declared structurally here as `FrameQuality` so this module stays free of any
// React/native import and is trivially unit-testable) plus, per frame, decides:
//   - what natural-language guidance to show the user ("Hold steady", "Move
//     closer", "Lighting is too dark", …),
//   - whether the current target angle is now steady + sharp enough to
//     auto-capture a full-resolution frame (best-frame selection),
//   - when to advance to the next angle in the multi-angle sequence,
//   - a progressive "evidence strength" meter (scan completeness — deliberately
//     NOT an identification-confidence claim; honest-AI: the real verdict only
//     ever comes from the cloud ensemble in orchestrate-scan),
//   - and when enough high-quality evidence has been collected to stop and hand
//     off to the existing createScan → uploadScanImage → runOrchestration
//     pipeline (intelligent stopping).
//
// Nothing here talks to the camera, the network, or the GPU. The live screen
// owns all of that and just feeds frames in and reacts to the decisions out.

export type Angle = "front" | "left" | "right" | "top" | "bottom" | "macro" | "wet";

// Structural subset of ImageProcessorGL's QualityAssessment — only the fields
// the engine reasons about. Kept local so the engine has zero imports.
export type FrameQuality = {
  qualityScore: number; // 0-1
  blurry: boolean;
  lowLight: boolean;
  overexposed: boolean;
  meanBrightness: number; // 0-1
  sharpness: number; // Laplacian-variance-like, higher = more in-focus detail
};

export type LiveGuidance =
  | "move_closer"
  | "hold_steady"
  | "too_dark"
  | "too_bright"
  | "collecting"
  | "excellent"
  | "rotate_next"
  | "complete";

export type AngleStep = { angle: Angle; label: string; optional?: boolean };

// Matches the auto-capture sequence in the spec (Front → Left → Right → Top →
// Bottom → Macro → optional Wet). Every angle here is a valid value of the
// scan_images.angle CHECK constraint in migration 0002_scan_pipeline.sql.
export const LIVE_ANGLE_SEQUENCE: readonly AngleStep[] = [
  { angle: "front", label: "front" },
  { angle: "left", label: "left side" },
  { angle: "right", label: "right side" },
  { angle: "top", label: "top" },
  { angle: "bottom", label: "bottom" },
  { angle: "macro", label: "macro close-up" },
  { angle: "wet", label: "wet specimen", optional: true },
];

export type LiveScanConfig = {
  sequence: readonly AngleStep[];
  // A frame counts as "good" only at/above this on-device quality score.
  minQuality: number;
  // Consecutive good+steady frames required before auto-capturing an angle.
  // This is what makes the scanner wait for a deliberately-held pose instead
  // of firing on a single lucky frame.
  requiredStableFrames: number;
  // Below this sharpness we assume the specimen is too far / not filling the
  // frame and ask the user to move closer, rather than just "hold steady".
  moveCloserSharpness: number;
  // Relative frame-to-frame sharpness change below which we consider the
  // camera steady (a moving camera produces erratic/again-and-again-changing
  // sharpness). 0.35 = tolerate 35% variation between sampled frames.
  steadyRelativeDelta: number;
  // Intelligent stopping: once at least this many required angles have a good
  // captured frame, the scan is allowed to complete even if the user never
  // reaches the end of the sequence (e.g. an awkward-to-rotate specimen).
  minAnglesToComplete: number;
};

export const DEFAULT_LIVE_CONFIG: LiveScanConfig = {
  sequence: LIVE_ANGLE_SEQUENCE,
  minQuality: 0.75,
  requiredStableFrames: 3,
  moveCloserSharpness: 2,
  steadyRelativeDelta: 0.35,
  minAnglesToComplete: 4,
};

export type LiveScanState = {
  currentStepIndex: number;
  capturedAngles: Angle[];
  stableGoodFrames: number;
  prevSharpness: number | null;
  bestQualityThisAngle: number;
  status: "scanning" | "ready";
};

export type FrameDecision = {
  state: LiveScanState;
  guidance: LiveGuidance;
  guidanceText: string;
  // Non-null => the live screen should grab ONE full-resolution frame and run
  // the enhance/detect pipeline for this angle. Null on every other frame,
  // which is what keeps us local-AI-first (no cloud calls, one full capture
  // only at the moment an angle locks in).
  captureAngle: Angle | null;
  evidenceStrength: number; // 0-1 scan-completeness meter (NOT an ID claim)
  isComplete: boolean;
};

export function createLiveScanState(): LiveScanState {
  return {
    currentStepIndex: 0,
    capturedAngles: [],
    stableGoodFrames: 0,
    prevSharpness: null,
    bestQualityThisAngle: 0,
    status: "scanning",
  };
}

const GUIDANCE_TEXT: Record<LiveGuidance, string> = {
  move_closer: "Move closer — fill the frame with the specimen",
  hold_steady: "Hold steady…",
  too_dark: "Lighting is too dark — find more light",
  too_bright: "Too bright — reduce glare or direct light",
  collecting: "Collecting more evidence…",
  excellent: "Excellent image — captured",
  rotate_next: "",
  complete: "Analyzing — enough high-quality evidence collected",
};

function requiredAngles(config: LiveScanConfig): Angle[] {
  return config.sequence.filter((s) => !s.optional).map((s) => s.angle);
}

function isComplete(state: LiveScanState, config: LiveScanConfig): boolean {
  const required = requiredAngles(config);
  const capturedRequired = required.filter((a) => state.capturedAngles.includes(a));
  if (capturedRequired.length >= required.length) return true;
  // Intelligent stop: past the end of the sequence, accept a viable subset.
  if (
    state.currentStepIndex >= config.sequence.length &&
    state.capturedAngles.length >= config.minAnglesToComplete &&
    state.capturedAngles.includes("front")
  ) {
    return true;
  }
  return false;
}

export function evidenceStrength(state: LiveScanState, config: LiveScanConfig): number {
  const required = requiredAngles(config);
  const captured = required.filter((a) => state.capturedAngles.includes(a)).length;
  return Math.max(0, Math.min(1, captured / required.length));
}

// True once there is at least a front frame — lets the UI offer a manual
// "Analyze now" button before the full sequence is done.
export function canAnalyze(state: LiveScanState): boolean {
  return state.capturedAngles.includes("front");
}

export function nextAngleLabel(
  state: LiveScanState,
  config: LiveScanConfig = DEFAULT_LIVE_CONFIG,
): string | null {
  const step = config.sequence[state.currentStepIndex];
  return step ? step.label : null;
}

// The core reducer: pure (state, frame) -> decision. The caller replaces its
// state with `decision.state`.
export function processFrame(
  state: LiveScanState,
  q: FrameQuality,
  config: LiveScanConfig = DEFAULT_LIVE_CONFIG,
): FrameDecision {
  if (state.status === "ready" || state.currentStepIndex >= config.sequence.length) {
    const ready: LiveScanState = { ...state, status: "ready" };
    return {
      state: ready,
      guidance: "complete",
      guidanceText: GUIDANCE_TEXT.complete,
      captureAngle: null,
      evidenceStrength: evidenceStrength(ready, config),
      isComplete: true,
    };
  }

  const step = config.sequence[state.currentStepIndex];

  const steady =
    state.prevSharpness !== null &&
    Math.abs(q.sharpness - state.prevSharpness) <=
      config.steadyRelativeDelta * Math.max(state.prevSharpness, 0.01);

  const good = !q.blurry && !q.lowLight && !q.overexposed && q.qualityScore >= config.minQuality;

  // Guidance priority: correct the most blocking problem first.
  let guidance: LiveGuidance;
  if (q.lowLight) guidance = "too_dark";
  else if (q.overexposed) guidance = "too_bright";
  else if (q.sharpness < config.moveCloserSharpness) guidance = "move_closer";
  else if (q.blurry || !steady) guidance = "hold_steady";
  else guidance = "collecting";

  const nextStableGoodFrames = good && steady ? state.stableGoodFrames + 1 : 0;
  const bestQualityThisAngle = Math.max(state.bestQualityThisAngle, q.qualityScore);

  // Not yet enough held frames → keep scanning this angle.
  if (nextStableGoodFrames < config.requiredStableFrames) {
    const nextState: LiveScanState = {
      ...state,
      stableGoodFrames: nextStableGoodFrames,
      prevSharpness: q.sharpness,
      bestQualityThisAngle,
    };
    return {
      state: nextState,
      guidance,
      guidanceText: GUIDANCE_TEXT[guidance],
      captureAngle: null,
      evidenceStrength: evidenceStrength(nextState, config),
      isComplete: false,
    };
  }

  // Locked in → capture this angle and advance.
  const capturedAngles = state.capturedAngles.includes(step.angle)
    ? state.capturedAngles
    : [...state.capturedAngles, step.angle];

  let advanced: LiveScanState = {
    ...state,
    capturedAngles,
    currentStepIndex: state.currentStepIndex + 1,
    stableGoodFrames: 0,
    prevSharpness: null,
    bestQualityThisAngle: 0,
  };

  const complete = isComplete(advanced, config);
  if (complete) advanced = { ...advanced, status: "ready" };

  return {
    state: advanced,
    guidance: complete ? "complete" : "excellent",
    guidanceText: complete ? GUIDANCE_TEXT.complete : GUIDANCE_TEXT.excellent,
    captureAngle: step.angle,
    evidenceStrength: evidenceStrength(advanced, config),
    isComplete: complete,
  };
}

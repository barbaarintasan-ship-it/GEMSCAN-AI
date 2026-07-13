// Intelligent Auto Scan Lock — the pure, framework-free decision layer that
// sits ON TOP OF the existing Live Scan engine (lib/liveScanEngine.ts) without
// replacing any of it.
//
// The Live Scan engine already decides *when to capture each angle* and drives
// the on-device "evidence collected" completeness meter (scan completeness —
// deliberately NOT an identification claim). This module answers the separate,
// higher-level question the Auto Scan Lock feature adds:
//
//   Given what we've collected so far, should we (a) spend ONE cloud AI
//   evaluation, (b) LOCK because the cloud is already confident enough, or
//   (c) keep scanning and collecting more evidence?
//
// Everything here is a pure function of plain inputs — no camera, network,
// React or native imports — so the "don't waste cloud calls / battery" policy
// and the auto-lock threshold logic are fully unit-testable in isolation.
//
// Honest-AI note: `confidence` in this module always refers to the REAL
// ensemble confidence returned by orchestrate-scan (Stage 5). The on-device
// "evidence quality" is a separate, clearly-named signal about how good the
// captured imagery is — it is never presented as an identification confidence.

export type AutoLockConfig = {
  // Ensemble confidence at/above which the scan auto-locks (default 0.95).
  // This is only a *fallback* default — the authoritative value comes from the
  // backend (SCAN_AUTOLOCK_THRESHOLD, surfaced as `autoLockThreshold` on the
  // orchestrate-scan response), satisfying "threshold configurable from the
  // backend". The live screen passes the backend value in once it's known.
  threshold: number;
  // On-device evidence quality (0-1) that must be reached before we're willing
  // to spend the first cloud evaluation. Prevents burning a cloud call on a
  // single blurry front frame.
  evalReadyEvidence: number;
  // After an evaluation that came back below threshold, require at least this
  // many NEWLY captured angles before spending another cloud call — so we only
  // re-ask the cloud when we actually have new evidence for it to consider.
  minNewAnglesBetweenEvals: number;
  // Hard cap on automatic cloud evaluations per scan. The single biggest lever
  // for "prevent unnecessary cloud AI requests / low API cost". A manual
  // "Analyze now" / "Keep scanning" is always still allowed beyond this.
  maxAutoEvals: number;
};

export const DEFAULT_AUTOLOCK_CONFIG: AutoLockConfig = {
  threshold: 0.95,
  evalReadyEvidence: 0.5,
  minNewAnglesBetweenEvals: 1,
  maxAutoEvals: 3,
};

// Clamp a backend-provided threshold into a sane [0,1] range, falling back to
// the default when it's missing or malformed. Used where the live screen folds
// the server's `autoLockThreshold` into its config.
export function resolveThreshold(backendThreshold: number | null | undefined): number {
  if (typeof backendThreshold !== "number" || Number.isNaN(backendThreshold)) {
    return DEFAULT_AUTOLOCK_CONFIG.threshold;
  }
  return Math.max(0, Math.min(1, backendThreshold));
}

// "Evidence Quality" indicator (req 9): a blend of how good the captured
// imagery is (average on-device quality score) and how much of the specimen we
// have seen (distinct angle coverage). Returns 0-1. This is what the live HUD
// shows as an "Evidence Quality" bar, distinct from raw scan completeness.
export function computeEvidenceQuality(
  capturedQualities: number[],
  capturedAngles: number,
  requiredAngles: number,
): number {
  if (capturedQualities.length === 0 || requiredAngles <= 0) return 0;
  const avgQuality =
    capturedQualities.reduce((sum, q) => sum + clamp01(q), 0) / capturedQualities.length;
  const coverage = clamp01(capturedAngles / requiredAngles);
  // Quality-leaning blend: a few excellent angles is worth more than many poor
  // ones, but breadth of coverage still matters for a trustworthy verdict.
  return clamp01(0.6 * avgQuality + 0.4 * coverage);
}

export type AutoLockAction = "lock" | "evaluate" | "scan";

export type AutoLockInputs = {
  // Most recent REAL ensemble confidence (0-1) from orchestrate-scan, or null
  // if the cloud has never been asked for this scan yet.
  lastConfidence: number | null;
  // Current on-device Evidence Quality (see computeEvidenceQuality).
  evidenceQuality: number;
  // Distinct angles captured so far.
  capturedAngles: number;
  // Distinct angles that had been captured at the time of the last cloud eval
  // (0 if no eval has happened yet).
  anglesAtLastEval: number;
  // How many automatic cloud evaluations have already been spent this scan.
  evalsUsed: number;
  config: AutoLockConfig;
};

export type AutoLockDecision = {
  action: AutoLockAction;
  // Machine-readable reason, handy for tests/telemetry and for choosing the
  // right on-screen copy.
  reason:
    | "confident_lock"
    | "first_eval"
    | "new_evidence_eval"
    | "budget_exhausted"
    | "not_enough_evidence"
    | "awaiting_new_angles";
};

// Core decision. Order matters:
//   1. If the cloud is already confident enough → LOCK (and, by returning
//      "lock", the caller stops sending any further cloud requests — req 6).
//   2. Else if we have enough fresh evidence and budget → EVALUATE (one call).
//   3. Else → keep SCANNING.
export function decideAutoLock(inputs: AutoLockInputs): AutoLockDecision {
  const { lastConfidence, evidenceQuality, capturedAngles, anglesAtLastEval, evalsUsed, config } =
    inputs;

  if (lastConfidence !== null && lastConfidence >= config.threshold) {
    return { action: "lock", reason: "confident_lock" };
  }

  if (evidenceQuality < config.evalReadyEvidence) {
    return { action: "scan", reason: "not_enough_evidence" };
  }

  if (evalsUsed >= config.maxAutoEvals) {
    return { action: "scan", reason: "budget_exhausted" };
  }

  // First cloud look is allowed as soon as evidence is ready.
  if (lastConfidence === null) {
    return { action: "evaluate", reason: "first_eval" };
  }

  // A subsequent look only makes sense once we have genuinely new angles for
  // the cloud to weigh — otherwise we'd re-ask the same question and waste a
  // call/battery for an identical answer.
  if (capturedAngles - anglesAtLastEval >= config.minNewAnglesBetweenEvals) {
    return { action: "evaluate", reason: "new_evidence_eval" };
  }

  return { action: "scan", reason: "awaiting_new_angles" };
}

export type LockCopy = { headline: string; sub: string };

// Copy for the auto-lock moment (req 3): "High confidence achieved." then
// "Analysis complete." Kept here so it's covered by the pure tests and shared
// consistently by the live screen.
export const AUTO_LOCK_COPY: LockCopy = {
  headline: "High confidence achieved.",
  sub: "Analysis complete.",
};

// Keep-scanning guidance for when confidence is below threshold (req 4). Picks
// the most useful next instruction from the collected-evidence picture. Frame-
// level guidance ("hold steady", "too dark") still comes from liveScanEngine;
// this adds the higher-level "get more/different evidence" nudges.
export function keepScanningGuidance(evidenceQuality: number, capturedAngles: number): string {
  if (capturedAngles === 0) return "Point the camera at your specimen";
  if (capturedAngles < 2) return "Rotate the specimen to show another surface";
  if (evidenceQuality < 0.5) return "Improve lighting and move closer for a clearer view";
  return "Capture another surface to raise confidence";
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

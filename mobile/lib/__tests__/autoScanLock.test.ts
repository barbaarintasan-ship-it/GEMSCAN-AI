// Unit tests for the pure Auto Scan Lock decision layer (lib/autoScanLock.ts).
// Pure inputs -> decision, so the "when to lock / when to spend a cloud call /
// when to keep scanning" policy and the Evidence Quality blend are exercised
// directly with no camera, network, or React involved.
import {
  decideAutoLock,
  computeEvidenceQuality,
  resolveThreshold,
  keepScanningGuidance,
  DEFAULT_AUTOLOCK_CONFIG,
  AUTO_LOCK_COPY,
  type AutoLockInputs,
} from "../autoScanLock";

function inputs(overrides: Partial<AutoLockInputs> = {}): AutoLockInputs {
  return {
    lastConfidence: null,
    evidenceQuality: 0.9,
    capturedAngles: 2,
    anglesAtLastEval: 0,
    evalsUsed: 0,
    config: DEFAULT_AUTOLOCK_CONFIG,
    ...overrides,
  };
}

describe("resolveThreshold", () => {
  it("defaults to 0.95 when missing or malformed", () => {
    expect(resolveThreshold(undefined)).toBe(0.95);
    expect(resolveThreshold(null)).toBe(0.95);
    expect(resolveThreshold(NaN)).toBe(0.95);
  });

  it("clamps backend values into [0,1]", () => {
    expect(resolveThreshold(0.8)).toBe(0.8);
    expect(resolveThreshold(1.5)).toBe(1);
    expect(resolveThreshold(-0.2)).toBe(0);
  });
});

describe("computeEvidenceQuality", () => {
  it("is 0 with no captured images", () => {
    expect(computeEvidenceQuality([], 0, 6)).toBe(0);
  });

  it("blends average quality and angle coverage into [0,1]", () => {
    // avg quality 1.0, coverage 3/6 = 0.5 -> 0.6*1 + 0.4*0.5 = 0.8
    expect(computeEvidenceQuality([1, 1, 1], 3, 6)).toBeCloseTo(0.8, 5);
  });

  it("rewards full coverage with high quality", () => {
    expect(computeEvidenceQuality([0.9, 0.9, 0.9, 0.9, 0.9, 0.9], 6, 6)).toBeGreaterThan(0.85);
  });

  it("stays within [0,1] even with out-of-range inputs", () => {
    const v = computeEvidenceQuality([2, -1, 5], 99, 6);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
});

describe("decideAutoLock", () => {
  it("locks once real confidence reaches the threshold", () => {
    const d = decideAutoLock(inputs({ lastConfidence: 0.96 }));
    expect(d.action).toBe("lock");
    expect(d.reason).toBe("confident_lock");
  });

  it("locks exactly at the threshold boundary", () => {
    const d = decideAutoLock(inputs({ lastConfidence: 0.95 }));
    expect(d.action).toBe("lock");
  });

  it("respects a lower backend-configured threshold", () => {
    const config = { ...DEFAULT_AUTOLOCK_CONFIG, threshold: 0.8 };
    expect(decideAutoLock(inputs({ lastConfidence: 0.82, config })).action).toBe("lock");
  });

  it("does not spend a cloud call until evidence quality is ready", () => {
    const d = decideAutoLock(inputs({ evidenceQuality: 0.3, lastConfidence: null }));
    expect(d.action).toBe("scan");
    expect(d.reason).toBe("not_enough_evidence");
  });

  it("spends the first cloud eval once evidence is ready", () => {
    const d = decideAutoLock(inputs({ evidenceQuality: 0.9, lastConfidence: null }));
    expect(d.action).toBe("evaluate");
    expect(d.reason).toBe("first_eval");
  });

  it("re-evaluates only after new angles are captured since the last eval", () => {
    // Same angle count as at last eval, confidence below threshold -> wait.
    const waiting = decideAutoLock(
      inputs({ lastConfidence: 0.6, capturedAngles: 3, anglesAtLastEval: 3 }),
    );
    expect(waiting.action).toBe("scan");
    expect(waiting.reason).toBe("awaiting_new_angles");

    // One more angle -> worth another look.
    const again = decideAutoLock(
      inputs({ lastConfidence: 0.6, capturedAngles: 4, anglesAtLastEval: 3 }),
    );
    expect(again.action).toBe("evaluate");
    expect(again.reason).toBe("new_evidence_eval");
  });

  it("stops spending cloud calls once the auto-eval budget is exhausted (cost guard)", () => {
    const d = decideAutoLock(
      inputs({
        lastConfidence: 0.6,
        capturedAngles: 6,
        anglesAtLastEval: 3,
        evalsUsed: DEFAULT_AUTOLOCK_CONFIG.maxAutoEvals,
      }),
    );
    expect(d.action).toBe("scan");
    expect(d.reason).toBe("budget_exhausted");
  });

  it("locks even when the budget is exhausted, if confidence is already high enough", () => {
    // req 6: a confident lock must always win over the budget guard so we never
    // keep scanning when we already have a good-enough answer.
    const d = decideAutoLock(
      inputs({ lastConfidence: 0.97, evalsUsed: DEFAULT_AUTOLOCK_CONFIG.maxAutoEvals }),
    );
    expect(d.action).toBe("lock");
  });
});

describe("keepScanningGuidance", () => {
  it("guides from nothing captured through to raising confidence", () => {
    expect(keepScanningGuidance(0, 0)).toMatch(/Point the camera/i);
    expect(keepScanningGuidance(0.9, 1)).toMatch(/Rotate/i);
    expect(keepScanningGuidance(0.3, 3)).toMatch(/lighting/i);
    expect(keepScanningGuidance(0.9, 3)).toMatch(/another surface/i);
  });
});

describe("AUTO_LOCK_COPY", () => {
  it("matches the required auto-lock messaging", () => {
    expect(AUTO_LOCK_COPY.headline).toBe("High confidence achieved.");
    expect(AUTO_LOCK_COPY.sub).toBe("Analysis complete.");
  });
});

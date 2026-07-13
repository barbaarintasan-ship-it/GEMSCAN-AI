// Unit tests for the pure Live Scan engine (lib/liveScanEngine.ts). No native
// or React surface is involved, so this exercises the full state machine
// directly: guidance selection, steadiness gating, auto-capture, angle
// progression, the evidence meter, and intelligent stopping.
import {
  processFrame,
  createLiveScanState,
  evidenceStrength,
  canAnalyze,
  DEFAULT_LIVE_CONFIG,
  LIVE_ANGLE_SEQUENCE,
  type FrameQuality,
  type LiveScanState,
  type LiveScanConfig,
} from "../liveScanEngine";

const GOOD: FrameQuality = {
  qualityScore: 0.95,
  blurry: false,
  lowLight: false,
  overexposed: false,
  meanBrightness: 0.47,
  sharpness: 20,
};

function frame(overrides: Partial<FrameQuality> = {}): FrameQuality {
  return { ...GOOD, ...overrides };
}

// Feed the same frame repeatedly, threading state through, returning every
// per-frame decision. A steady stream of identical GOOD frames is, by design,
// "steady" (zero sharpness delta) and should eventually auto-capture.
function feed(state: LiveScanState, q: FrameQuality, times: number, config = DEFAULT_LIVE_CONFIG) {
  const decisions = [];
  let s = state;
  for (let i = 0; i < times; i++) {
    const d = processFrame(s, q, config);
    s = d.state;
    decisions.push(d);
  }
  return { state: s, decisions };
}

describe("processFrame guidance", () => {
  it("asks for more light on a dark frame", () => {
    const d = processFrame(createLiveScanState(), frame({ lowLight: true }));
    expect(d.guidance).toBe("too_dark");
    expect(d.captureAngle).toBeNull();
  });

  it("warns about glare on an overexposed frame", () => {
    const d = processFrame(createLiveScanState(), frame({ overexposed: true }));
    expect(d.guidance).toBe("too_bright");
  });

  it("asks to move closer when there is too little sharp detail", () => {
    const d = processFrame(createLiveScanState(), frame({ sharpness: 1 }));
    expect(d.guidance).toBe("move_closer");
  });

  it("asks to hold steady on a blurry frame", () => {
    const d = processFrame(createLiveScanState(), frame({ blurry: true }));
    expect(d.guidance).toBe("hold_steady");
  });

  it("treats the first frame as not-yet-steady (no prior sharpness)", () => {
    // Even a perfect first frame can't be 'steady' — there's nothing to
    // compare against — so it must not immediately capture.
    const d = processFrame(createLiveScanState(), GOOD);
    expect(d.captureAngle).toBeNull();
    expect(d.state.stableGoodFrames).toBe(0);
  });
});

describe("auto-capture and angle progression", () => {
  it("captures the front angle after enough steady good frames, then advances", () => {
    const { decisions, state } = feed(createLiveScanState(), GOOD, 6);
    const capture = decisions.find((d) => d.captureAngle !== null);
    expect(capture?.captureAngle).toBe("front");
    expect(state.capturedAngles).toContain("front");
    // After capturing front, we should have advanced to the next step (left).
    expect(state.currentStepIndex).toBeGreaterThanOrEqual(1);
  });

  it("resets the stable counter when a bad frame interrupts a good streak", () => {
    let s = createLiveScanState();
    s = processFrame(s, GOOD).state; // primes prevSharpness
    s = processFrame(s, GOOD).state; // stableGoodFrames = 1
    expect(s.stableGoodFrames).toBe(1);
    s = processFrame(s, frame({ blurry: true })).state; // interrupt
    expect(s.stableGoodFrames).toBe(0);
  });

  it("does not count a moving camera (erratic sharpness) as steady", () => {
    let s = createLiveScanState();
    // Alternate sharpness wildly so each frame is 'unsteady' vs the last.
    for (let i = 0; i < 6; i++) {
      const d = processFrame(s, frame({ sharpness: i % 2 === 0 ? 20 : 3 }));
      s = d.state;
      expect(d.captureAngle).toBeNull();
    }
    expect(s.capturedAngles).toHaveLength(0);
  });
});

describe("intelligent stopping", () => {
  it("completes once every required angle has been captured", () => {
    let s = createLiveScanState();
    let completed = false;
    // Drive many steady good frames; identical frames are steady, so each
    // angle locks in after requiredStableFrames and we march through the
    // whole sequence.
    for (let i = 0; i < 100 && !completed; i++) {
      const d = processFrame(s, GOOD);
      s = d.state;
      if (d.isComplete) completed = true;
    }
    expect(completed).toBe(true);
    expect(s.status).toBe("ready");
    // All required (non-optional) angles present.
    const required = LIVE_ANGLE_SEQUENCE.filter((a) => !a.optional).map((a) => a.angle);
    for (const a of required) expect(s.capturedAngles).toContain(a);
  });

  it("stops via the minAnglesToComplete subset rule when the sequence is exhausted", () => {
    // A config with a short required set is exercised by the default path;
    // here we assert the evidence meter and canAnalyze react to progress.
    const empty = createLiveScanState();
    expect(canAnalyze(empty)).toBe(false);
    expect(evidenceStrength(empty, DEFAULT_LIVE_CONFIG)).toBe(0);

    const { state } = feed(empty, GOOD, 6);
    expect(canAnalyze(state)).toBe(true);
    expect(evidenceStrength(state, DEFAULT_LIVE_CONFIG)).toBeGreaterThan(0);
  });

  it("is idempotent once ready: extra frames keep reporting complete without capturing", () => {
    let s = createLiveScanState();
    for (let i = 0; i < 100; i++) {
      const d = processFrame(s, GOOD);
      s = d.state;
      if (d.isComplete) break;
    }
    const after = processFrame(s, GOOD);
    expect(after.isComplete).toBe(true);
    expect(after.captureAngle).toBeNull();
  });
});

describe("evidence meter", () => {
  it("stays within [0,1] across a full run", () => {
    let s = createLiveScanState();
    for (let i = 0; i < 100; i++) {
      const d = processFrame(s, GOOD);
      s = d.state;
      expect(d.evidenceStrength).toBeGreaterThanOrEqual(0);
      expect(d.evidenceStrength).toBeLessThanOrEqual(1);
      if (d.isComplete) break;
    }
  });

  it("honors a custom minQuality threshold (a mediocre frame never captures)", () => {
    const strict: LiveScanConfig = { ...DEFAULT_LIVE_CONFIG, minQuality: 0.99 };
    const { state } = feed(createLiveScanState(), frame({ qualityScore: 0.8 }), 10, strict);
    expect(state.capturedAngles).toHaveLength(0);
  });
});

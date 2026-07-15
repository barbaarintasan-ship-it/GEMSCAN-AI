// Device compatibility + diagnostics layer.
//
// Two jobs:
//  1. COMPATIBILITY: remember, per app session, whether on-device GPU/GL image
//     analysis actually works on THIS device. The first time a GL operation
//     fails or returns invalid (all-black) data we latch "GPU disabled" and
//     never attempt or retry GL again — the scanner runs CPU-only from then on.
//     This is what makes the scanner device-independent (low-end phones,
//     Samsung/Pixel/Xiaomi/Motorola/OnePlus …) with no GPU requirement.
//  2. DIAGNOSTICS: a small ring buffer of stage logs + a metrics snapshot,
//     surfaced in the hidden Debug screen so failures are inspectable.
//
// Nothing here ever throws.

export type GpuState = "unknown" | "available" | "disabled";

export type StageLog = {
  t: number; // epoch ms
  stage: string;
  detail?: string;
  level: "info" | "error";
};

type Metrics = {
  cameraResolution: string | null;
  cameraFps: string | null;
  imageDimensions: string | null;
  uploadSizeKb: number | null;
  currentProvider: string | null;
  openGlStatus: string;
  tensorflowStatus: string;
  cpuFallbackActive: boolean;
  lastScanMs: number | null;
};

const MAX_LOGS = 120;

let gpuState: GpuState = "unknown";
const logs: StageLog[] = [];
const stageStart: Record<string, number> = {};

const metrics: Metrics = {
  cameraResolution: null,
  cameraFps: null,
  imageDimensions: null,
  uploadSizeKb: null,
  currentProvider: null,
  openGlStatus: "unknown",
  tensorflowStatus: "disabled (not bundled)",
  cpuFallbackActive: false,
  lastScanMs: null,
};

function push(entry: StageLog) {
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();
  // Mirror to the JS console for `adb logcat`/Metro visibility during
  // development only — production stays quiet (the Debug screen reads the
  // in-memory `logs` array, not the console).
  if (__DEV__) {
    const tag = entry.level === "error" ? "[GEMSCAN✗]" : "[GEMSCAN]";
    // eslint-disable-next-line no-console
    console.log(`${tag} ${entry.stage}${entry.detail ? ` — ${entry.detail}` : ""}`);
  }
}

export const diag = {
  // ── GPU capability ──────────────────────────────────────────────────────
  gpuState(): GpuState {
    return gpuState;
  },
  isGpuDisabled(): boolean {
    return gpuState === "disabled";
  },
  markGpuWorking() {
    if (gpuState === "unknown") {
      gpuState = "available";
      metrics.openGlStatus = "working";
      push({ t: Date.now(), stage: "gpu_available", level: "info" });
    }
  },
  // Latch GPU off for the rest of the session. Never retried.
  markGpuDisabled(reason: string) {
    if (gpuState !== "disabled") {
      gpuState = "disabled";
      metrics.openGlStatus = `disabled (${reason})`;
      metrics.cpuFallbackActive = true;
      push({ t: Date.now(), stage: "gpu_disabled", detail: reason, level: "error" });
    }
  },

  // ── Stage logging ───────────────────────────────────────────────────────
  log(stage: string, detail?: string) {
    push({ t: Date.now(), stage, detail, level: "info" });
  },
  error(stage: string, detail?: string) {
    push({ t: Date.now(), stage, detail, level: "error" });
  },
  // Mark a stage start; `end` logs the elapsed ms.
  begin(stage: string) {
    stageStart[stage] = Date.now();
    push({ t: Date.now(), stage: `${stage}:start`, level: "info" });
  },
  end(stage: string, detail?: string) {
    const started = stageStart[stage];
    const ms = started ? Date.now() - started : undefined;
    push({
      t: Date.now(),
      stage: `${stage}:done`,
      detail: [detail, ms != null ? `${ms}ms` : undefined].filter(Boolean).join(" "),
      level: "info",
    });
    return ms;
  },

  // ── Metrics ─────────────────────────────────────────────────────────────
  setMetric<K extends keyof Metrics>(key: K, value: Metrics[K]) {
    metrics[key] = value;
  },
  getMetrics(): Metrics {
    return { ...metrics };
  },
  getLogs(): StageLog[] {
    return [...logs].reverse(); // newest first
  },
  clear() {
    logs.length = 0;
  },
};

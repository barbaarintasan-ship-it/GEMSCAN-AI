// On-device classifier "provider".
//
// This is NOT a network call — Stage 2 (YOLO detect + TensorFlow Lite coarse
// classify) already ran on the phone before the scan was ever uploaded. This
// adapter just wraps that already-computed hint in the same VisionProvider
// shape so it participates in the weighted ensemble (Stage 5) and gets
// persisted to scan_ai_responses (Stage 7) like every other provider,
// without index.ts needing a special case for it.
import type { ProviderInput, ProviderResult, VisionProvider } from "./types.ts";

export const onDeviceClassifierProvider: VisionProvider = {
  name: "on_device_classifier",
  // Deliberately low weight: a coarse mobile-friendly model is far less
  // reliable than the full cloud vision models, but still useful signal
  // (especially as a tie-breaker or corroborating vote).
  baseWeight: 0.1,
  isApplicable: (input) => input.onDeviceHint !== null,

  identify(input: ProviderInput): Promise<ProviderResult> {
    const start = Date.now();
    if (!input.onDeviceHint) {
      return Promise.resolve({
        provider: "on_device_classifier",
        candidate: null,
        alternatives: [],
        reasoning: "",
        latencyMs: 0,
        error: "No on-device hint supplied with this scan",
      });
    }

    return Promise.resolve({
      provider: "on_device_classifier",
      candidate: {
        label: input.onDeviceHint.label,
        confidence: input.onDeviceHint.confidence,
      },
      alternatives: [],
      reasoning: "Coarse on-device TensorFlow Lite classification, computed before upload.",
      latencyMs: Date.now() - start,
    });
  },
};

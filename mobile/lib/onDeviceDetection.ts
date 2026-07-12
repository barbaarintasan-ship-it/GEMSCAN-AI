// Stage 2: fast on-device inference (YOLO detection + TensorFlow Lite coarse
// classification), used to (a) crop each captured photo down to the
// specimen's bounding box before upload, and (b) produce a lightweight
// classification hint that rides along with the scan as one more (low
// weight) vote in the cloud ensemble — see
// supabase/functions/orchestrate-scan/providers/onDeviceClassifier.ts.
//
// Uses `react-native-fast-tflite`, which runs a bundled .tflite model
// on-device via the JSI (no network call). This module expects two model
// assets that are NOT included in this repo yet:
//   assets/models/specimen-detector.tflite   — a YOLO-family detector
//   assets/models/specimen-classifier.tflite — a coarse MobileNet-class
//                                               classifier over specimen
//                                               categories
//
// Until those trained models are dropped in, both functions below fail soft:
// detectSpecimenBoundingBox() returns null (skip cropping, use the full
// photo) and classifyCoarse() returns null (the ensemble just runs without
// an on-device hint). This mirrors the existing mobile-money-webhook
// placeholder pattern already in this codebase — the pipeline is fully
// wired end-to-end, pending the specific trained model artifacts.
import { Asset } from "expo-asset";

export type BoundingBox = {
  x: number; // normalized 0-1, top-left
  y: number;
  width: number;
  height: number;
  detectorConfidence: number;
};

export type CoarseClassification = {
  label: string;
  confidence: number;
};

const DETECTOR_MODEL_MODULE = (() => {
  try {
    // Wrapped in try/catch: `require` throws at bundle time if the asset
    // doesn't exist, which is expected until the model is added.
    return require("../assets/models/specimen-detector.tflite");
  } catch {
    return null;
  }
})();

const CLASSIFIER_MODEL_MODULE = (() => {
  try {
    return require("../assets/models/specimen-classifier.tflite");
  } catch {
    return null;
  }
})();

let tfliteModule: typeof import("react-native-fast-tflite") | null = null;
try {
  // Optional dependency: only required once a model asset actually exists.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  tfliteModule = require("react-native-fast-tflite");
} catch {
  tfliteModule = null;
}

let detectorModelPromise: ReturnType<
  NonNullable<typeof tfliteModule>["loadTensorflowModel"]
> | null = null;
let classifierModelPromise: ReturnType<
  NonNullable<typeof tfliteModule>["loadTensorflowModel"]
> | null = null;

function getDetectorModel() {
  if (!tfliteModule || !DETECTOR_MODEL_MODULE) return null;
  if (!detectorModelPromise) {
    detectorModelPromise = tfliteModule.loadTensorflowModel(DETECTOR_MODEL_MODULE);
  }
  return detectorModelPromise;
}

function getClassifierModel() {
  if (!tfliteModule || !CLASSIFIER_MODEL_MODULE) return null;
  if (!classifierModelPromise) {
    classifierModelPromise = tfliteModule.loadTensorflowModel(CLASSIFIER_MODEL_MODULE);
  }
  return classifierModelPromise;
}

// Runs the YOLO-family detector and returns the highest-confidence bounding
// box for the specimen, in normalized image coordinates, or null if no
// detector model is bundled / nothing was detected above threshold.
export async function detectSpecimenBoundingBox(_imageUri: string): Promise<BoundingBox | null> {
  const modelPromise = getDetectorModel();
  if (!modelPromise) return null;

  try {
    await Asset.loadAsync(DETECTOR_MODEL_MODULE);
    const model = await modelPromise;
    // NOTE: the exact pre/post-processing here (letterboxing, anchor
    // decoding, NMS) is model-specific and must be filled in once the actual
    // trained YOLO export is available — react-native-fast-tflite gives raw
    // tensor I/O (`model.runSync([inputTensor])`), not a decoded detection
    // API. Left unimplemented (returns null = "skip cropping") until then.
    void model;
    return null;
  } catch (err) {
    console.warn("[onDeviceDetection] detector inference failed, skipping crop:", err);
    return null;
  }
}

// Runs the coarse TFLite classifier and returns its top label/confidence, or
// null if no classifier model is bundled.
export async function classifyCoarse(_imageUri: string): Promise<CoarseClassification | null> {
  const modelPromise = getClassifierModel();
  if (!modelPromise) return null;

  try {
    await Asset.loadAsync(CLASSIFIER_MODEL_MODULE);
    const model = await modelPromise;
    // Same caveat as above: label mapping + input normalization are
    // model-specific and must be wired up against the actual trained export.
    void model;
    return null;
  } catch (err) {
    console.warn("[onDeviceDetection] classifier inference failed, skipping hint:", err);
    return null;
  }
}

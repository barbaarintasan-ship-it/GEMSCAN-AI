// Stage 2 (on-device inference) — currently a no-op.
//
// The design allows for an optional on-device YOLO detector (to crop each
// captured photo to the specimen's bounding box) and a coarse TFLite
// classifier (a lightweight hint that rides along as one low-weight vote in the
// cloud ensemble). Neither trained model artifact exists yet, so both functions
// below fail soft:
//   - detectSpecimenBoundingBox() returns null → the full photo is uploaded
//     without cropping.
//   - classifyCoarse() returns null → the cloud ensemble runs without an
//     on-device hint.
//
// The heavy native TFLite runtime was intentionally removed from the app until
// a real model ships: shipping a multi-megabyte native inference engine that
// loads no model only inflates the binary and the App Store review surface for
// zero user benefit. When a trained `.tflite` export is ready, reintroduce the
// runtime here behind these same two function signatures — nothing else in the
// pipeline needs to change.

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

// Returns the specimen bounding box in normalized image coordinates, or null
// when no on-device detector model is bundled (currently always null).
export async function detectSpecimenBoundingBox(_imageUri: string): Promise<BoundingBox | null> {
  return null;
}

// Returns a coarse on-device label/confidence hint, or null when no classifier
// model is bundled (currently always null).
export async function classifyCoarse(_imageUri: string): Promise<CoarseClassification | null> {
  return null;
}

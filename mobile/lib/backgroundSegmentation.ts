// Stage 3 (final step): background segmentation.
//
// Genuine background segmentation needs a real on-device segmentation model
// (e.g. a MediaPipe Selfie/Object segmentation export, or a custom-trained
// specimen-vs-background TFLite model) — this is a neural-network problem,
// not something a shader pipeline alone can solve, unlike the white-balance/
// exposure/sharpen steps in components/ImageProcessorGL.tsx.
//
// Until such a model is bundled (see mobile/lib/onDeviceDetection.ts for the
// same pattern with the detector/classifier models), this is a documented
// no-op passthrough: the enhanced image is returned unchanged, with
// `applied: false` so callers/telemetry can see segmentation didn't run
// rather than silently assuming it did.
export async function segmentBackground(uri: string): Promise<{ uri: string; applied: boolean }> {
  // TODO: once a bundled segmentation model exists, run it here to produce
  // an alpha mask and composite the specimen over a neutral background
  // before this image is uploaded — this measurably helps cloud vision
  // models focus on the specimen rather than a cluttered background.
  return { uri, applied: false };
}

// How large a field photo may be when it leaves the phone.
//
// WHY THIS EXISTS AS ITS OWN MODULE
// ---------------------------------
// Production showed that photo SIZE, not photo count, was killing analysis:
// samples averaging 5–7 MB per photo failed, including one with only three
// photos, while samples at ~100 KB analysed fine. The old app compressed to
// ~100 KB; the current one uploads the sensor's full frame.
//
// The policy is separated from the upload call so it can be TESTED. The first
// version of it was written inline and was wrong in a way no test could catch,
// because there was no test: it resized by WIDTH, which on a portrait photo —
// most outcrop shots — leaves the long edge far above the intended limit.
// A 3000x4000 frame became 2048x2731, nearly twice the pixels intended.

/**
 * Longest edge a photo is uploaded at.
 *
 * 2048 px keeps everything a geologist photographs legible — grain, veining,
 * alteration coatings, a hand-lens view — at roughly half a megabyte. It also
 * matters at the other end of the wire: uploading 8 MB over a rural Somali
 * cellular link is minutes per photo, and this app is used where that link is
 * the good day.
 */
export const UPLOAD_MAX_EDGE_PX = 2048;

/** JPEG quality for the uploaded copy. Above ~0.85 the file grows and the rock does not. */
export const UPLOAD_JPEG_QUALITY = 0.85;

export interface ResizeTarget {
  width: number;
  height: number;
}

/**
 * The size to send, given the photo's real dimensions.
 *
 * Returns null when the photo is already small enough — re-encoding a 900 px
 * photo only loses detail and gains nothing.
 *
 * Scales the LONG edge to the limit and lets the short edge follow, so the
 * aspect ratio is preserved and a portrait photo is capped by the same rule as
 * a landscape one.
 */
export function resizeTargetFor(
  width: number,
  height: number,
  maxEdge: number = UPLOAD_MAX_EDGE_PX,
): ResizeTarget | null {
  // Unknown or nonsense dimensions: do nothing rather than resize to garbage.
  // The upload path treats null as "send as-is", which is the safe direction —
  // a slow upload beats a corrupted one.
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  const longest = Math.max(width, height);
  if (longest <= maxEdge) return null;

  const scale = maxEdge / longest;
  return {
    // Round, then floor at 1: a very long thin panorama could otherwise scale
    // its short edge to zero and produce an image with no pixels.
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Rough encoded size of a JPEG at these dimensions, in bytes.
 *
 * Only used to explain the budget in logs and diagnostics — never to decide
 * anything. JPEG size depends on the scene, so this is an order-of-magnitude
 * estimate at the quality this app uploads with, not a measurement.
 */
export function estimateJpegBytes(width: number, height: number): number {
  // ~0.13 bytes per pixel at quality 0.85 on typical outdoor rock photography.
  return Math.round(width * height * 0.13);
}

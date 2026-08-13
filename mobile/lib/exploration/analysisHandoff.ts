// Handing a finished sample back to the live map.
//
// The capture screen used to return with `router.replace('/exploration',
// { analysed })`, which reads as "go back to the map" and is not: replace swaps
// the TOP of the stack, so a second exploration screen — a second provider, a
// second GPS watch, a second map surface — was mounted on top of the one that
// had been running the whole time. The session survived by luck, not by design.
//
// Under the map-first architecture the map is a layout that never unmounts, so
// the capture screen simply pops back to it. That leaves nowhere to put a URL
// parameter, which is fine: a sample id is not navigation state. It goes in a
// slot, exactly as the camera already hands photographs to the sample form
// (see lib/captureHandoff.ts) — same pattern, same reasoning.
//
// Deliberately NOT persisted. If the process died between the analysis and the
// map reading it, the sample is still safely on the server; re-folding it into a
// session that no longer exists would be worse than not folding it in at all.

let pending: string | null = null;

/** Called by the capture flow once a sample has been submitted. */
export function putAnalysedSample(sampleId: string): void {
  pending = sampleId;
}

/** Reads and CLEARS — draining on read is what stops a re-render folding twice. */
export function takeAnalysedSample(): string | null {
  const out = pending;
  pending = null;
  return out;
}

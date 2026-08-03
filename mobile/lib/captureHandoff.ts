// Photo handoff between the field camera and the sample form.
//
// Expo Router passes params through a URL, which is the wrong place for a list
// of file paths: they are long, they contain characters that need escaping, and
// a burst of eight makes a URL nobody can debug. This is a single in-memory
// slot instead — the camera fills it, the form drains it, and it is empty
// again straight after.
//
// Deliberately NOT persisted. A photo that survives a process restart but whose
// sample draft did not would reappear attached to the wrong sample, and a
// misfiled field photo is worse than a lost one.
export interface CapturedPhoto {
  uri: string;
  width: number;
  height: number;
  /** Which requested shot this satisfies, when the camera was opened for one. */
  need: string | null;
  takenAt: number;
}

let slot: CapturedPhoto[] = [];

export function putCapturedPhotos(photos: CapturedPhoto[]): void {
  slot = photos;
}

/** Reads and CLEARS. Draining on read is what stops a re-render adding them twice. */
export function takeCapturedPhotos(): CapturedPhoto[] {
  const out = slot;
  slot = [];
  return out;
}

export function hasCapturedPhotos(): boolean {
  return slot.length > 0;
}

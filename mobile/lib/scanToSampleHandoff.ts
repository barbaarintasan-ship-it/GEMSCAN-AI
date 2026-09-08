// Handing a finished SCAN into the Sample capture form.
//
// The scan already identified a specimen and already has its photos in storage.
// Rather than make the user re-photograph the same rock, the scan-result CTA
// drops the identification here and the sample form drains it — same in-memory
// slot pattern as captureHandoff.ts / analysisHandoff.ts (put fills, take reads
// AND clears, so a re-render can't apply it twice).
//
// What travels is only the IDENTIFICATION and the scanId. The photos are NOT
// carried as bytes: the server copies them from the scan by scanId (see the
// createSample handler), so each sample owns its own media and deleting a sample
// never disturbs the scan it came from.
//
// Deliberately NOT persisted: a hand-off that outlived the scan result it came
// from would pre-fill a stale rock onto an unrelated sample.
export interface ScanHandoff {
  scanId: string;
  /** The scan's best-match label — an AI CANDIDATE, pre-filled editable as method='ai'. */
  rockName: string;
  /** 0..1 ensemble confidence for the candidate. Drives the "unconfirmed" framing. */
  confidence: number;
  /** Other candidates the scan considered, offered as quick-select chips. */
  alternatives: string[];
}

let slot: ScanHandoff | null = null;

export function putScanHandoff(h: ScanHandoff): void {
  slot = h;
}

/** Reads and CLEARS. Draining on read is what stops a re-render applying it twice. */
export function takeScanHandoff(): ScanHandoff | null {
  const out = slot;
  slot = null;
  return out;
}

export function peekScanHandoff(): ScanHandoff | null {
  return slot;
}

// Shared shape passed from the Batch Scan screen to the Batch Results screen.
// Kept in its own module (no logic) so both screens import the same type
// without one screen depending on the other.
import type { ScanType } from "./scanUpload";

export type BatchItemStatus = "completed" | "failed" | "skipped";

export type BatchItemResult = {
  imageUri: string; // local device uri — used as the results-screen thumbnail
  scanId: string | null; // null when the item was never scanned (failed before an id existed, or skipped)
  status: BatchItemStatus;
  label: string | null; // AI best match (null if insufficient/failed/skipped)
  confidencePct: number | null;
  band: "low" | "medium" | "high" | null;
  valueLabel: string | null; // pre-formatted estimate, e.g. "USD 120–300"
  scanType: ScanType;
  errorMessage: string | null;
};

// Set when the batch stopped early because an entitlement limit was hit —
// lets the results screen show the right explanation instead of a generic one.
export type BatchStopReason = "deep_credits_exhausted" | "standard_limit_reached" | null;

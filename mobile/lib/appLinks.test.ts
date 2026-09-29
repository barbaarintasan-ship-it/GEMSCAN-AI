import { isScanLimitError, STANDARD_LIMIT_REACHED_CODE } from "./appLinks";

// Regression coverage for the scan-limit detector. The lifetime cap changed the
// server's message wording, and a prior audit found the old detector only knew
// the daily wording — so the lifetime paywall never showed. These lock in that
// BOTH message wordings and the machine code are recognized, and that unrelated
// errors are not misclassified as a scan-limit.

describe("isScanLimitError", () => {
  test("recognizes the machine code (wording-independent, preferred signal)", () => {
    expect(isScanLimitError({ code: STANDARD_LIMIT_REACHED_CODE })).toBe(true);
    expect(isScanLimitError({ code: "standard_limit_reached", message: "anything" })).toBe(true);
  });

  test("recognizes the OLD daily-limit message", () => {
    expect(isScanLimitError("Daily Standard Scan limit reached. Please try again tomorrow.")).toBe(true);
    // as a string and as an error-like object with only a message
    expect(isScanLimitError({ message: "Daily Standard Scan limit reached." })).toBe(true);
  });

  test("recognizes the NEW lifetime-limit message (the defect this fixes)", () => {
    expect(
      isScanLimitError("You've used all of your free lifetime scans. Upgrade to keep scanning."),
    ).toBe(true);
    expect(
      isScanLimitError({ message: "You've used all of your free lifetime scans. Upgrade to keep scanning." }),
    ).toBe(true);
  });

  test("does NOT misclassify unrelated errors", () => {
    expect(isScanLimitError("Network request failed")).toBe(false);
    expect(isScanLimitError("Scan not found")).toBe(false);
    expect(isScanLimitError({ code: "deep_credits_exhausted", message: "Your Deep Scan credits are finished." })).toBe(false);
    expect(isScanLimitError("No images found for this scan")).toBe(false);
  });

  test("handles missing / empty input safely", () => {
    expect(isScanLimitError(null)).toBe(false);
    expect(isScanLimitError(undefined)).toBe(false);
    expect(isScanLimitError("")).toBe(false);
    expect(isScanLimitError({})).toBe(false);
    expect(isScanLimitError({ code: null, message: null })).toBe(false);
  });

  test("code wins even when the message is unrelated (robust to wording changes)", () => {
    expect(isScanLimitError({ code: STANDARD_LIMIT_REACHED_CODE, message: "totally different future wording" })).toBe(true);
  });
});

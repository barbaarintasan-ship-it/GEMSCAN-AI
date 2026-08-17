// Another unguarded cold-start call, found the same way as getSession(),
// appUpdate.check and the tile downloads — this fetch carried no timeout,
// and useSubscriptionStatus fires it the moment a session becomes available,
// which is exactly when the app is opened.
// subscription.ts imports useAuth, which imports lib/supabase, which throws
// at import time with no env configured — same reason every other module in
// this app that touches Supabase requires it lazily. Mocked here so the
// import chain never reaches it; this file exercises fetchSubscriptionStatus
// directly and never needs a real auth context.
jest.mock("../auth", () => ({ useAuth: jest.fn() }));

import { fetchSubscriptionStatus, SUBSCRIPTION_TIMEOUT_MS } from "../subscription";

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

test("a stalled connection is aborted at the ceiling, not left hanging", async () => {
  const fetchMock = jest.fn((_url: string, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const e = new Error("Aborted");
        e.name = "AbortError";
        reject(e);
      });
    }));
  const originalFetch = global.fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).fetch = fetchMock;

  try {
    const result = fetchSubscriptionStatus("tok-123");
    // Attached before the clock moves, so the rejection is never unhandled
    // for even one tick.
    const rejects = expect(result).rejects.toThrow();
    await jest.advanceTimersByTimeAsync(SUBSCRIPTION_TIMEOUT_MS);
    await rejects;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The real fetch received an abortable signal, which is what makes the
    // ceiling above actually stop the request rather than merely stop
    // waiting for it.
    const init = fetchMock.mock.calls[0][1] as { signal?: AbortSignal };
    expect(init.signal).toBeInstanceOf(AbortSignal);
  } finally {
    global.fetch = originalFetch;
  }
});

test("a fast, successful response is not affected by the ceiling", async () => {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      tier: "free", status: "active", currentPeriodEnd: null, source: null,
      features: {}, deepScan: null,
    }),
  });
  const originalFetch = global.fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).fetch = fetchMock;

  try {
    const result = await fetchSubscriptionStatus("tok-123");
    expect(result.tier).toBe("free");
  } finally {
    global.fetch = originalFetch;
  }
});

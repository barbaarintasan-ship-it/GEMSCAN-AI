// THE SECOND UNBOUNDED COLD-START NETWORK CALL.
//
// UpdateGate (components/UpdateGate.tsx) fires checkForUpdate() from the app
// ROOT on every launch, same as AuthProvider's getSession(). This query
// carried no timeout either, so a stalled connection to the same backend left
// it pending indefinitely — one more way a cold start could sit waiting on a
// network this offline-first app has no business depending on.
jest.mock("expo-application", () => ({ nativeBuildVersion: "100" }));

const mockMaybeSingle = jest.fn();
jest.mock("../supabase", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        limit: () => ({
          maybeSingle: (...a: unknown[]) => mockMaybeSingle(...a),
        }),
      }),
    }),
  },
}));

import { checkForUpdate, UPDATE_CHECK_TIMEOUT_MS } from "../appUpdate";

beforeEach(() => {
  jest.useFakeTimers();
  mockMaybeSingle.mockReset();
});

afterEach(() => { jest.useRealTimers(); });

test("a query that never answers resolves to null at the ceiling, not never", async () => {
  // A stalled connection: this never settles on its own.
  mockMaybeSingle.mockImplementation(() => new Promise(() => {}));

  const result = checkForUpdate();
  await jest.advanceTimersByTimeAsync(UPDATE_CHECK_TIMEOUT_MS);
  // Fail open — indistinguishable from offline, which this module already
  // treats as "nothing to show", never as a reason to keep waiting.
  expect(await result).toBeNull();
});

test("a query that answers quickly is not affected by the ceiling", async () => {
  mockMaybeSingle.mockResolvedValue({
    data: { latest_build: 999, min_build: 1, update_message_en: null, update_message_so: null, store_url: null },
    error: null,
  });

  const result = await checkForUpdate();
  expect(result?.updateAvailable).toBe(true);
});

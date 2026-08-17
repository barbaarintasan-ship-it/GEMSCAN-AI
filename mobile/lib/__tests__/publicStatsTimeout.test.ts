// Another unguarded cold-start call, the same class as getSession(),
// appUpdate.check, subscription.fetch and the tile downloads. Unlike
// subscription, this one needs no session — it reads with the anon key — so
// it fires the instant the home screen mounts, which is why it kept showing
// up as an unattributed freeze even after the session-gated calls were fixed.
const mockRpc = jest.fn();
jest.mock("../supabase", () => ({ supabase: { rpc: (...a: unknown[]) => mockRpc(...a) } }));

import { fetchPublicStats, usePublicStats } from "../publicStats";

beforeEach(() => {
  jest.useFakeTimers();
  mockRpc.mockReset();
});
afterEach(() => { jest.useRealTimers(); });

test("a stalled query resolves to the zero-stats fallback, not never", async () => {
  // supabase.rpc() returns a thenable query builder, not a plain Promise —
  // mocked the same shape here: an object whose .then never calls back.
  mockRpc.mockReturnValue({ then: () => {} });

  const result = fetchPublicStats();
  await jest.advanceTimersByTimeAsync(10_000);
  expect(await result).toEqual({ registeredUsers: 0, confirmedGems: 0 });
});

test("a fast, successful response is not affected by the ceiling", async () => {
  mockRpc.mockResolvedValue({ data: { registered_users: 42, confirmed_gems: 7 }, error: null });
  const result = await fetchPublicStats();
  expect(result).toEqual({ registeredUsers: 42, confirmedGems: 7 });
});

test("usePublicStats is exported and callable", () => {
  expect(typeof usePublicStats).toBe("function");
});

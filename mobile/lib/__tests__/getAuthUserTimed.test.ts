// THE UNBOUNDED CALL THE ORIGINAL TIMEOUT CAMPAIGN MISSED.
//
// getSession()/appUpdate/pushOutbox were all fixed for the stalled-connection
// cold-start freeze (see withTimeout.ts's own header note) — but
// supabase.auth.getUser() always makes its own network round-trip to
// validate the token (unlike getSession(), which can resolve from a cached
// local session), so it was exposed to the exact same failure mode at every
// one of its 14 call sites across 6 files, none of which had a ceiling.
const mockGetUser = jest.fn();
jest.mock("../supabase", () => ({
  supabase: { auth: { getUser: (...a: unknown[]) => mockGetUser(...a) } },
}));

import { getAuthUserTimed, GET_USER_TIMEOUT_MS } from "../getAuthUserTimed";

beforeEach(() => {
  jest.useFakeTimers();
  mockGetUser.mockReset();
});
afterEach(() => { jest.useRealTimers(); });

test("a getUser() call that never answers resolves to null at the ceiling, not never", async () => {
  mockGetUser.mockImplementation(() => new Promise(() => {})); // a stalled connection
  const result = getAuthUserTimed();
  await jest.advanceTimersByTimeAsync(GET_USER_TIMEOUT_MS);
  // Falls back to null — the SAME outcome every call site already treats as
  // "not signed in", so a timeout is indistinguishable from an expired
  // session, never a hang.
  expect(await result).toBeNull();
});

test("a getUser() call that answers quickly returns the real user, unaffected by the ceiling", async () => {
  mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
  const result = await getAuthUserTimed();
  expect(result).toEqual({ id: "u1" });
});

test("getUser() rejecting outright also falls back to null, rather than throwing", async () => {
  mockGetUser.mockRejectedValue(new Error("network exploded"));
  const result = await getAuthUserTimed();
  expect(result).toBeNull();
});

test("no signed-in user (data.user is null) resolves to null, same as today", async () => {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
  const result = await getAuthUserTimed();
  expect(result).toBeNull();
});

import { withTimeout } from "../withTimeout";

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

test("a promise that never settles resolves to the fallback at the ceiling", async () => {
  const result = withTimeout(new Promise(() => {}), 5_000, "fallback");
  await jest.advanceTimersByTimeAsync(5_000);
  expect(await result).toBe("fallback");
});

test("a promise that resolves first wins, and the timer never fires", async () => {
  const result = withTimeout(Promise.resolve("real"), 5_000, "fallback");
  expect(await result).toBe("real");
  // The pending timer is cleared, not merely outraced — nothing left running.
  expect(jest.getTimerCount()).toBe(0);
});

test("a promise that rejects also falls back, rather than throwing", async () => {
  const result = withTimeout(Promise.reject(new Error("boom")), 5_000, "fallback");
  expect(await result).toBe("fallback");
});

test("resolving just under the ceiling still wins over the fallback", async () => {
  let resolve!: (v: string) => void;
  const p = new Promise<string>((r) => { resolve = r; });
  const result = withTimeout(p, 5_000, "fallback");
  await jest.advanceTimersByTimeAsync(4_000);
  resolve("just in time");
  expect(await result).toBe("just in time");
});

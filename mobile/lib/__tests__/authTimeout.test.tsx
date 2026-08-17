// THE UP-TO-209-SECOND FREEZE THIS FIXES.
//
// app/index.tsx and app/(app)/_layout.tsx both gate their ENTIRE screen on
// AuthProvider's `isLoading`, showing nothing but a spinner until it clears.
// It used to clear only when supabase.auth.getSession() resolved — and that
// call can itself wait on an internal token refresh with no timeout of its
// own. MEASURED repeatedly on a device: a stalled connection to the auth
// endpoint on a cold app start left the ENTIRE APP on a loading screen for
// 51-209 seconds, exactly the moment a geologist opens the app in the field —
// the one moment this offline-first app may least afford to wait on a network.
//
// This asserts the fix at the level the freeze was actually visible: the
// consumer-facing `isLoading` flag, not the internal timer.
import React from "react";
import renderer, { act, type ReactTestRenderer } from "react-test-renderer";

const mockGetSession = jest.fn();
const mockOnAuthStateChange = jest.fn();

jest.mock("../supabase", () => ({
  supabase: {
    auth: {
      getSession: (...a: unknown[]) => mockGetSession(...a),
      onAuthStateChange: (...a: unknown[]) => mockOnAuthStateChange(...a),
    },
  },
}));

import { AuthProvider, useAuth } from "../auth";

/** Mounts the provider and records every value its context has held. */
function mount() {
  const seen: Array<{ isLoading: boolean; session: unknown }> = [];
  function Probe() {
    const { isLoading, session } = useAuth();
    seen.push({ isLoading, session });
    return null;
  }
  let tree!: ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
  });
  return {
    latest: () => seen[seen.length - 1],
    unmount: () => act(() => { tree.unmount(); }),
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  mockOnAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: () => {} } } });
});

afterEach(() => { jest.useRealTimers(); });

test("a getSession() that never resolves does not hold the loading screen forever", async () => {
  // A stalled connection: this promise is never going to settle on its own.
  mockGetSession.mockImplementation(() => new Promise(() => {}));

  const probe = mount();
  expect(probe.latest().isLoading).toBe(true);

  // Short of the ceiling: still waiting, exactly as a real fast answer would be.
  await act(async () => {
    await jest.advanceTimersByTimeAsync(7_000);
  });
  expect(probe.latest().isLoading).toBe(true);

  // At the ceiling: the app proceeds without a session rather than hanging.
  await act(async () => {
    await jest.advanceTimersByTimeAsync(1_500);
  });
  expect(probe.latest().isLoading).toBe(false);
  expect(probe.latest().session).toBeNull();
});

test("a getSession() that answers quickly is not affected by the ceiling", async () => {
  mockGetSession.mockResolvedValue({ data: { session: { user: { id: "u1", email: "a@b.com" } } } });

  const probe = mount();
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(probe.latest().isLoading).toBe(false);
  expect(probe.latest().session).not.toBeNull();
});

test("a late answer, arriving after the ceiling, still updates the session", async () => {
  let resolve!: (v: { data: { session: unknown } }) => void;
  mockGetSession.mockImplementation(() => new Promise((r) => { resolve = r; }));

  const probe = mount();
  await act(async () => {
    await jest.advanceTimersByTimeAsync(8_000);
  });
  // The ceiling already let the app in, signed out.
  expect(probe.latest().isLoading).toBe(false);
  expect(probe.latest().session).toBeNull();

  // The real answer finally lands — the app is not stuck reporting "signed
  // out" for a user who, it turns out, was signed in all along.
  await act(async () => {
    resolve({ data: { session: { user: { id: "u1", email: "a@b.com" } } } });
    await Promise.resolve();
  });
  expect(probe.latest().session).not.toBeNull();
});

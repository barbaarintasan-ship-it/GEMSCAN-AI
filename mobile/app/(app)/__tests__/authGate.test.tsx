// The gate that ended the Karkaar expedition.
//
// On 07–08/08/2026 a geologist drove 130 km into the Karkaar mountains and worked
// through the night with no signal. About an hour in, the access token expired.
// The refresh failed — no network. `onAuthStateChange` propagated a null session,
// and `(app)/_layout` did this:
//
//     if (!session) return <Redirect href="/(auth)/login" />;
//
// A login screen, in a place where signing in is impossible. Everything they were
// actually doing needed no identity at all: local map, local pack, local GPS,
// local storage. The expedition ended there.
//
// Two failures, not one, and each needs its own test:
//
//   (app)/_layout   the token expiring MID-session
//   app/index       Android killing the app overnight, so the next launch has
//                   nothing in memory and decides on `session` alone
//
// Both are decided by rendering, so both are tested by rendering. A behavioural
// test is the only kind that can catch this: the types were always satisfied.
import React from "react";
import renderer, { type ReactTestRenderer } from "react-test-renderer";
import {
  ExpeditionLeaseStore, __setExpeditionLeaseForTests,
} from "../../../lib/exploration/expeditionLease";
import type { KeyValueAdapter } from "../../../lib/samples/localSampleStore";

// ── What each gate renders, captured rather than navigated ─────────────────
const redirects: string[] = [];

jest.mock("expo-router", () => {
  const React2 = require("react");
  const Stack = ({ children }: { children?: React.ReactNode }) =>
    React2.createElement(React2.Fragment, null, children);
  (Stack as unknown as { Screen: unknown }).Screen = () => null;
  return {
    Stack,
    Redirect: ({ href }: { href: string }) => {
      redirects.push(typeof href === "string" ? href : JSON.stringify(href));
      return null;
    },
    router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  };
});

jest.mock("../../../components/LoadingScreen", () => {
  const { Text } = require("react-native");
  const React2 = require("react");
  return { __esModule: true, default: () => React2.createElement(Text, null, "loading") };
});

// The session under test. Set per case.
const auth: { session: unknown; isLoading: boolean } = { session: null, isLoading: false };
jest.mock("../../../lib/auth", () => ({ useAuth: () => auth }));

function memoryStorage(): KeyValueAdapter {
  const map = new Map<string, string>();
  return {
    getItem: async (k) => map.get(k) ?? null,
    setItem: async (k, v) => { map.set(k, v); },
  };
}

/** Render, then flush the lease's async load so the gate can decide. */
async function render(node: React.ReactElement): Promise<string> {
  let tree!: ReactTestRenderer;
  await renderer.act(async () => { tree = renderer.create(node); });
  await renderer.act(async () => { await Promise.resolve(); });
  const out = JSON.stringify(tree.toJSON());
  tree.unmount();
  return out;
}

async function withLease(open: boolean, detached = false) {
  const store = new ExpeditionLeaseStore({ storage: memoryStorage() });
  if (open) {
    await store.open("ex-karkaar", { userId: "u-1", email: "awmusse@example.com" });
    if (detached) await store.detach();
  }
  __setExpeditionLeaseForTests(store);
  return store;
}

beforeEach(() => {
  redirects.length = 0;
  auth.session = null;
  auth.isLoading = false;
});

afterEach(() => { __setExpeditionLeaseForTests(null); });

// ── (app)/_layout — the mid-expedition eject ───────────────────────────────
describe("the app layout: an expiring token may not end an expedition", () => {
  const AppLayout = () => {
    // Required lazily so the mocks above are in place first.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Layout = require("../_layout").default;
    return <Layout />;
  };

  test("NO session and NO expedition still sends you to sign in", async () => {
    // The ordinary case, unchanged. Milestone 1 is scoped to Expedition Mode:
    // with no lease open, behaviour must be exactly what it was.
    await withLease(false);
    await render(<AppLayout />);
    expect(redirects).toEqual(["/(auth)/login"]);
  });

  test("NO session but an OPEN expedition stays in the app", async () => {
    // The Karkaar failure, asserted. This is the whole milestone.
    await withLease(true);
    await render(<AppLayout />);
    expect(redirects).toEqual([]);
  });

  test("a DETACHED expedition — signed out on purpose — also stays", async () => {
    await withLease(true, true);
    await render(<AppLayout />);
    expect(redirects).toEqual([]);
  });

  test("a session with no expedition behaves as it always did", async () => {
    auth.session = { user: { id: "u-1" } };
    await withLease(false);
    await render(<AppLayout />);
    expect(redirects).toEqual([]);
  });

  test("nothing is decided while the lease is still being read", async () => {
    // Deciding on auth alone before storage answers would flash the login screen
    // over a running expedition.
    const store = new ExpeditionLeaseStore({
      storage: { getItem: () => new Promise(() => {}), setItem: async () => {} },
    });
    __setExpeditionLeaseForTests(store);
    const out = await render(<AppLayout />);
    expect(redirects).toEqual([]);
    expect(out).toContain("loading");
  });
});

// ── app/index — the overnight process kill ─────────────────────────────────
describe("the entry point: a process kill may not end an expedition either", () => {
  const Index = () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Screen = require("../../index").default;
    return <Screen />;
  };

  test("cold start with no session and no expedition goes to sign in", async () => {
    await withLease(false);
    await render(<Index />);
    expect(redirects).toEqual(["/(auth)/login"]);
  });

  test("cold start with an OPEN expedition goes to the app, not to login", async () => {
    // Android reclaims a backgrounded app overnight. Fixing the layout alone
    // leaves this path deciding on `session`, and the geologist wakes to a login
    // screen with no signal.
    await withLease(true);
    await render(<Index />);
    expect(redirects).toEqual(["/(app)"]);
  });

  test("cold start with a session goes to the app as before", async () => {
    auth.session = { user: { id: "u-1" } };
    await withLease(false);
    await render(<Index />);
    expect(redirects).toEqual(["/(app)"]);
  });
});

// ── The way back in ─────────────────────────────────────────────────────────
//
// Lifting the gate had a consequence nobody predicted from the code, and it took
// being stuck in it on a real phone to see: with an open lease and no session the
// app never redirects to login — which was the ONLY route to the login screen. So
// signing back in became impossible from inside the app. Signed out, on the home
// screen, unable to authenticate and therefore unable to upload anything.
//
// Asserted against the SOURCE. A behavioural test of the home screen would need
// react-query, i18n, entitlements and a navigation host mocked, and would test
// those mocks as much as the property. What matters is narrower and structural:
// the door exists, and it is shown exactly when there is no session.
describe("a signed-out geologist can always reach the login screen", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("fs");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require("path");
  const home = fs.readFileSync(path.join(__dirname, "..", "index.tsx"), "utf8");
  const code = home.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  test("the home screen offers a route to login", () => {
    expect(code).toContain('router.push("/(auth)/login")');
  });

  test("it is shown only when there is no session", () => {
    // Guarded, or it would sit there permanently telling a signed-in geologist
    // to sign in.
    expect(code).toMatch(/\{!session \?[\s\S]{0,400}\/\(auth\)\/login/);
  });

  test("the enterprise entry falls back to the sealed identity", () => {
    // The other half of the same failure: the gate was lifted but the entry point
    // still asked for a live session, so the map became unreachable mid-expedition.
    expect(code).toContain("collectedBy?.email");
  });
});

// ── Every logout door goes through the policy ────────────────────────────────
//
// The three-option policy was written once and wired into account.tsx. settings.tsx
// kept calling signOut() directly, so the geologist who logs out from Settings —
// which is the one most people use — got no dialog and no policy at all. Two doors
// to the same decision, one of them unguarded. Found in a field test, not here,
// because nothing asserted the property.
//
// Source-level: the property is "which function is called", and there is no
// runtime state that reveals a bypass.
describe("no screen signs out behind the policy's back", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("fs");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require("path");

  const strip = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\/\/.*$/gm, "");

  /** Screens with a logout control. Add here when another gains one. */
  const doors = ["settings.tsx", "account.tsx"];

  for (const file of doors) {
    test(`${file} routes logout through requestFieldLogout`, () => {
      const src = strip(fs.readFileSync(path.join(__dirname, "..", file), "utf8"));
      expect(src).toContain("requestFieldLogout(");
    });

    test(`${file} never calls signOut() directly`, () => {
      const src = strip(fs.readFileSync(path.join(__dirname, "..", file), "utf8"));
      // `signOut` may be destructured from useAuth and handed to the policy; what
      // must not appear is an invocation of it outside that.
      const calls = src.match(/(?<!requestFieldLogout\([^)]*)\bawait\s+signOut\(\)/g) ?? [];
      expect(calls).toEqual([]);
    });
  }

  test("the policy itself is the only place signOut is invoked", () => {
    const policy = fs.readFileSync(
      path.join(__dirname, "..", "..", "..", "lib", "exploration", "fieldLogout.ts"),
      "utf8",
    );
    expect(policy).toContain("input.signOut()");
  });
});

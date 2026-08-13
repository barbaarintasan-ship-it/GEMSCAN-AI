// Does the workspace mount — and does it SURVIVE being left?
//
// Two properties, both invisible at runtime until they break:
//
//   1. The tree renders. Slice 1 moved the map and the session into layout
//      routes; nothing in the type system says the result can be rendered, and
//      when it could not, the app showed "something went wrong" and nothing else.
//
//   2. Leaving the map does not end the field session. The back arrow used to pop
//      the explore route, which unmounted the provider, which called
//      orchestrator.destroy() — ending the expedition and stopping the GPS watch
//      because somebody looked at their collection for ten seconds. The session
//      now lives in the ROOT layout, and this file is what keeps it there.
import React from "react";
import renderer, { type ReactTestRenderer } from "react-test-renderer";

// ── Platform edges ─────────────────────────────────────────────────────────
jest.mock("react-native-webview", () => {
  const { View } = require("react-native");
  return { WebView: View };
});

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 40, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("@react-native-community/netinfo", () => ({
  addEventListener: () => () => {},
  fetch: async () => ({ isConnected: true, isInternetReachable: true }),
}));

jest.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// The router: Slot renders whatever the test says the matched child is. The
// `mock` prefix is what lets a jest factory reference it.
const mockSlot: { child: React.ReactNode } = { child: null };
jest.mock("expo-router", () => {
  const React2 = require("react");
  const Stack = () => null;
  (Stack as unknown as { Screen: unknown }).Screen = () => null;
  return {
    Stack,
    Slot: () => React2.createElement(React2.Fragment, null, mockSlot.child),
    router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
    Redirect: () => null,
    useFocusEffect: (cb: () => void) => { React2.useEffect(() => { cb(); }, []); },
    useLocalSearchParams: () => ({}),
  };
});

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  },
}));

// The network client. A field screen must not need one to render — see the note
// in lib/sync/pushOutbox.ts about why this is loaded lazily there.
jest.mock("../../../../lib/supabase", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}));

// The engines reach these lazily; a mount must not need a device.
jest.mock("expo-location", () => ({
  requestForegroundPermissionsAsync: async () => ({ granted: false, canAskAgain: true }),
  hasServicesEnabledAsync: async () => false,
  getLastKnownPositionAsync: async () => null,
  getCurrentPositionAsync: async () => { throw new Error("no device"); },
  watchPositionAsync: async () => ({ remove: () => {} }),
  Accuracy: { Balanced: 3, High: 4, BestForNavigation: 6 },
}));

import ExploreLayout from "../_layout";
import ExplorationSurface from "../index";
import { ExplorationProvider, useExploration } from "../../../../lib/exploration/provider";
import { MapWorkspaceProvider, useMapWorkspace } from "../../../../lib/exploration/workspace";

/** The root layout's providers, which outlive every route. */
function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ExplorationProvider>
      <MapWorkspaceProvider>{children}</MapWorkspaceProvider>
    </ExplorationProvider>
  );
}

/** Records the identity of the things that must not be rebuilt. */
function Probe({ seen }: { seen: { orchestrator: unknown; workspaceId: string | null } }) {
  const { orchestrator } = useExploration();
  const { workspaceId } = useMapWorkspace();
  seen.orchestrator = orchestrator;
  seen.workspaceId = workspaceId;
  return null;
}

describe("the map workspace mounts", () => {
  test("the layout renders without throwing", () => {
    mockSlot.child = null;
    let tree: ReactTestRenderer | null = null;
    renderer.act(() => {
      tree = renderer.create(<Providers><ExploreLayout /></Providers>);
    });
    expect(tree).not.toBeNull();
    expect(tree!.toJSON()).not.toBeNull();
    // Unmounted, so the session's timers and listeners are released — a leaked
    // interval here is a leaked interval in the app.
    renderer.act(() => { tree!.unmount(); });
  });

  test("the layout renders with the sheet surface inside it", () => {
    // This is the real tree: providers → map host → the matched route.
    mockSlot.child = <ExplorationSurface />;
    let tree: ReactTestRenderer | null = null;
    renderer.act(() => {
      tree = renderer.create(<Providers><ExploreLayout /></Providers>);
    });
    expect(tree!.toJSON()).not.toBeNull();
    renderer.act(() => { tree!.unmount(); });
  });

  test("the surface refuses to render outside the workspace, loudly", () => {
    // A surface that forgets it belongs to the map host should say so rather
    // than reading undefined state and failing somewhere further away.
    expect(() => {
      renderer.act(() => { renderer.create(<ExplorationSurface />); });
    }).toThrow(/MapWorkspaceProvider|useExploration/);
  });
});

describe("leaving the map does not end the session", () => {
  test("the back arrow pops the route; the session and workspace are untouched", () => {
    mockSlot.child = null;
    const seen = { orchestrator: null as unknown, workspaceId: null as string | null };

    // A host that can drop the explore route the way the back arrow does.
    function Host({ onMap }: { onMap: boolean }) {
      return (
        <Providers>
          <Probe seen={seen} />
          {onMap ? <ExploreLayout /> : null}
        </Providers>
      );
    }

    let tree: ReactTestRenderer | null = null;
    renderer.act(() => { tree = renderer.create(<Host onMap />); });

    const onTheMap = { ...seen };
    expect(onTheMap.orchestrator).toBeTruthy();
    expect(onTheMap.workspaceId).toMatch(/^ws-/);

    // Back arrow: the route goes away.
    renderer.act(() => { tree!.update(<Host onMap={false} />); });

    // The engine is the SAME object — not rebuilt, and therefore not destroyed.
    expect(seen.orchestrator).toBe(onTheMap.orchestrator);
    // And the workspace was never remounted, which is what a changed id would
    // mean (see the diagnostics row of the same name).
    expect(seen.workspaceId).toBe(onTheMap.workspaceId);

    // Returning to the map reuses both.
    renderer.act(() => { tree!.update(<Host onMap />); });
    expect(seen.orchestrator).toBe(onTheMap.orchestrator);
    expect(seen.workspaceId).toBe(onTheMap.workspaceId);

    renderer.act(() => { tree!.unmount(); });
  });

  test("the explore layout mounts NO provider of its own — that is what would kill it", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "_layout.tsx"), "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toContain("ExplorationProvider");
    expect(src).not.toContain("MapWorkspaceProvider");
  });
});

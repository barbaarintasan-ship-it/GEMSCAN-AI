// How often downloaded tiles are allowed to reach React.
//
// THE STALL. "Marmar ayuu noqonayaa istaag oo aan waxba shaqaynayn gebigiisaba."
// The app froze solid, intermittently, and nothing on the device explained it:
// no ANR was ever filed, because it is the JS thread that blocks, not the UI
// thread, and Android only records the latter.
//
// The cause was one `setTiles` per arriving tile. Each of those re-rendered the
// whole workspace, re-serialised both tile lists, injected them into the WebView
// and repainted every tile drawn so far on top of 24 000 geology vertices. Sixty
// tiles cost sixty redraws of an ever-growing scene — quadratic work, on the one
// thread that answers buttons. It happened only when panning to new ground with
// a signal, which is exactly why it looked random.
//
// What is asserted here is the RATE, not the look: the backdrop must still build
// up progressively, and it must not be able to publish once per packet.
// `mock`-prefixed so jest allows the factory below to close over them.
const mockCachedTiles = jest.fn();
const mockDownloadMissing = jest.fn();

jest.mock("../geo/tileCache", () => ({
  cachedTiles: (...a: unknown[]) => mockCachedTiles(...a),
  downloadMissing: (...a: unknown[]) => mockDownloadMissing(...a),
  pruneCache: async () => {},
  padBbox: (b: number[]) => b,
  zoomForResolution: () => 14,
  isOverlaySource: (s: string) => s === "labels" || s === "roads",
  ATTRIBUTION: "",
}));

import React from "react";
import renderer, { act, type ReactTestRenderer } from "react-test-renderer";
import { useMapTiles, type MapTiles, type MapViewport } from "../geo/useMapTiles";

const VIEW: MapViewport = {
  bbox: [49.0, 9.4, 49.2, 9.6],
  metresPerPx: 20,
};

function tile(n: number) {
  return { uri: `file:///t${n}.png`, source: "imagery", x: n, y: 0, z: 14 };
}

/** Mounts the hook and counts how many times it rendered. */
function mount() {
  const seen: MapTiles[] = [];
  function Probe() {
    seen.push(useMapTiles(VIEW, { imagery: true }, true));
    return null;
  }
  let tree!: ReactTestRenderer;
  act(() => { tree = renderer.create(<Probe />); });
  return {
    renders: () => seen.length,
    latest: () => seen[seen.length - 1],
    unmount: () => act(() => { tree.unmount(); }),
  };
}

/** Let the settle delay, the disk read and every flush all run. */
async function settle() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      jest.advanceTimersByTime(400);
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  jest.useFakeTimers();
  mockCachedTiles.mockReset().mockResolvedValue([]);
  mockDownloadMissing.mockReset();
});

afterEach(() => { jest.useRealTimers(); });

test("sixty tiles landing at once do not cost sixty renders", async () => {
  // Every tile arrives inside one tick, as they do off a warm connection.
  mockDownloadMissing.mockImplementation(
    async (_b: unknown, _z: unknown, _s: unknown, o: { onProgress: (t: unknown) => void }) => {
      for (let i = 0; i < 60; i++) o.onProgress(tile(i));
    },
  );

  const probe = mount();
  await settle();

  expect(probe.latest().base).toHaveLength(60);
  // The exact figure depends on React's batching; the POINT is that it is
  // nothing like sixty. At or above that, the quadratic behaviour is back.
  expect(probe.renders()).toBeLessThan(15);
  probe.unmount();
});

test("the last tiles are published even when no timer fires after them", async () => {
  // A batch still in the buffer when the download ends must not wait for a flush
  // that will never come — with a weak signal, that is the whole backdrop.
  mockDownloadMissing.mockImplementation(
    async (_b: unknown, _z: unknown, _s: unknown, o: { onProgress: (t: unknown) => void }) => {
      o.onProgress(tile(1));
      o.onProgress(tile(2));
    },
  );

  const probe = mount();
  await settle();

  expect(probe.latest().base.map((t) => t.uri)).toEqual(["file:///t1.png", "file:///t2.png"]);
  expect(probe.latest().downloading).toBe(false);
  probe.unmount();
});

test("a tile already on screen does not manufacture a render of its own", async () => {
  mockDownloadMissing.mockImplementation(
    async (_b: unknown, _z: unknown, _s: unknown, o: { onProgress: (t: unknown) => void }) => {
      o.onProgress(tile(1));
      o.onProgress(tile(1));
      o.onProgress(tile(1));
    },
  );

  const probe = mount();
  await settle();

  expect(probe.latest().base).toHaveLength(1);
  probe.unmount();
});

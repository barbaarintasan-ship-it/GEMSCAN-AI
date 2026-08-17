// THE ROOT CAUSE, CONFIRMED ON DEVICE — A/B'd by hand: satellite, roads and
// labels OFF, cold start after cold start, never froze; the same three ON,
// it froze for 50+ seconds, repeatedly. FileSystem.downloadAsync() carries no
// timeout of its own, and it is reached only when a raster layer is on,
// which is exactly why the freeze correlated with those three layers and not
// the others already fixed (auth, appUpdate, pushOutbox, pullAnalysis,
// pushPhotos). One worker stuck on one stalled tile used to block the whole
// downloadMissing() pass forever.
const mockDownloadAsync = jest.fn();
const mockGetInfoAsync = jest.fn();
const mockDeleteAsync = jest.fn().mockResolvedValue(undefined);
const mockMakeDirectoryAsync = jest.fn().mockResolvedValue(undefined);

jest.mock("expo-file-system", () => ({
  cacheDirectory: "file:///cache/",
  makeDirectoryAsync: (...a: unknown[]) => mockMakeDirectoryAsync(...a),
  getInfoAsync: (...a: unknown[]) => mockGetInfoAsync(...a),
  downloadAsync: (...a: unknown[]) => mockDownloadAsync(...a),
  deleteAsync: (...a: unknown[]) => mockDeleteAsync(...a),
  readDirectoryAsync: jest.fn().mockResolvedValue([]),
}));

import { downloadMissing, TILE_DOWNLOAD_TIMEOUT_MS } from "../geo/tileCache";

const BBOX: [number, number, number, number] = [49.0, 9.4, 49.2, 9.6];

beforeEach(() => {
  jest.useFakeTimers();
  mockDownloadAsync.mockReset();
  mockGetInfoAsync.mockReset().mockResolvedValue({ exists: false });
});

afterEach(() => { jest.useRealTimers(); });

test("a stalled download does not block the whole pass forever", async () => {
  // Every tile requested stalls — the worst case, and the one measured on
  // the device: several tiles wanted, every one of them hanging. Capped at
  // CONCURRENCY (4) tiles so each worker hits exactly one stalled download,
  // not a chain of them — the chain is what the second test below covers.
  mockDownloadAsync.mockImplementation(() => new Promise(() => {}));

  const result = downloadMissing(BBOX, 12, "imagery", { max: 4 });
  await jest.advanceTimersByTimeAsync(TILE_DOWNLOAD_TIMEOUT_MS + 100);
  const written = await result;

  // Nothing landed — every attempt stalled — but the CALL RETURNED, which a
  // 51-second (or permanent) hang would not have.
  expect(written).toBe(0);
  // The half-written file from a timed-out attempt is not left behind to be
  // mistaken for a real tile later.
  expect(mockDeleteAsync).toHaveBeenCalled();
}, 15_000);

test("a stalled tile does not stop the others from downloading", async () => {
  let call = 0;
  mockDownloadAsync.mockImplementation(() => {
    call++;
    // The very first request hangs; everything after it answers normally —
    // exactly the shape of one bad connection among several good ones.
    if (call === 1) return new Promise(() => {});
    return Promise.resolve({ status: 200, uri: "file:///cache/sat-tiles/t.png" });
  });

  const result = downloadMissing(BBOX, 12, "imagery", { max: 8 });
  await jest.advanceTimersByTimeAsync(TILE_DOWNLOAD_TIMEOUT_MS + 100);
  const written = await result;

  // At least the tiles behind the stalled one still landed.
  expect(written).toBeGreaterThan(0);
});

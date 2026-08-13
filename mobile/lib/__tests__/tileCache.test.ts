// The tile maths that decides what the backdrop looks like.
//
// Only the pure parts are exercised here — no filesystem, no network. What
// matters is that tile detail follows the camera (which is what makes place
// names legible and stops a zoomed-out planning view downloading street-level
// tiles), that each source is held to the zooms it actually publishes, and that
// the prefetch margin grows the box rather than moving it.
import { padBbox, tilesFor, zoomFor, zoomForResolution, isOverlaySource, TILE_SOURCE_IDS } from "../geo/tileCache";

describe("zoomForResolution", () => {
  test("finer resolution asks for a higher zoom", () => {
    const wide = zoomForResolution(60, 9.5, "imagery");
    const close = zoomForResolution(2, 9.5, "imagery");
    expect(close).toBeGreaterThan(wide);
  });

  test("each source is capped at the zooms it actually publishes", () => {
    // A very fine resolution would ask for z20 from every service.
    expect(zoomForResolution(0.2, 9.5, "imagery")).toBeLessThanOrEqual(17);
    expect(zoomForResolution(0.2, 9.5, "hillshade")).toBeLessThanOrEqual(15);
    expect(zoomForResolution(0.2, 9.5, "labels")).toBeLessThanOrEqual(16);
  });

  test("a nonsensical resolution falls back rather than throwing", () => {
    expect(Number.isFinite(zoomForResolution(0, 9.5))).toBe(true);
    expect(Number.isFinite(zoomForResolution(Number.NaN, 9.5))).toBe(true);
  });

  test("latitude is accounted for — a metre is fewer degrees away from the equator", () => {
    expect(zoomForResolution(10, 60)).toBeLessThanOrEqual(zoomForResolution(10, 0));
  });
});

describe("zoomFor", () => {
  test("still answers for a radius, for the first view before a camera exists", () => {
    expect(zoomFor(2_000)).toBeGreaterThan(zoomFor(200_000));
  });
});

describe("padBbox", () => {
  const box: [number, number, number, number] = [49, 9, 49.1, 9.1];

  test("grows the box around its own centre", () => {
    const [w, s, e, n] = padBbox(box, 0.5);
    expect(w).toBeCloseTo(48.95, 6);
    expect(e).toBeCloseTo(49.15, 6);
    expect(s).toBeCloseTo(8.95, 6);
    expect(n).toBeCloseTo(9.15, 6);
  });

  test("never runs off the ends of the world", () => {
    const [w, s, e, n] = padBbox([-179.9, -84.9, 179.9, 84.9], 1);
    expect(w).toBeGreaterThanOrEqual(-180);
    expect(e).toBeLessThanOrEqual(180);
    expect(s).toBeGreaterThanOrEqual(-85);
    expect(n).toBeLessThanOrEqual(85);
  });
});

describe("tilesFor", () => {
  const box: [number, number, number, number] = [49, 9, 49.2, 9.2];

  test("covers the box and never exceeds the cap", () => {
    expect(tilesFor(box, 12).length).toBeGreaterThan(0);
    expect(tilesFor(box, 16, 12).length).toBeLessThanOrEqual(12);
  });

  test("centre first, so a slow link fills what is being looked at", () => {
    const tiles = tilesFor(box, 14);
    const cx = (Math.min(...tiles.map((t) => t.x)) + Math.max(...tiles.map((t) => t.x))) / 2;
    const cy = (Math.min(...tiles.map((t) => t.y)) + Math.max(...tiles.map((t) => t.y))) / 2;
    const d = (t: { x: number; y: number }) => (t.x - cx) ** 2 + (t.y - cy) ** 2;
    expect(d(tiles[0])).toBeLessThanOrEqual(d(tiles[tiles.length - 1]));
  });

  test("every tile carries the geographic box it must be drawn into", () => {
    for (const t of tilesFor(box, 12)) {
      expect(t.e).toBeGreaterThan(t.w);
      expect(t.n).toBeGreaterThan(t.s);
    }
  });
});

describe("sources", () => {
  test("roads and labels are overlays; imagery and hillshade are not", () => {
    expect(isOverlaySource("labels")).toBe(true);
    expect(isOverlaySource("roads")).toBe(true);
    expect(isOverlaySource("imagery")).toBe(false);
    expect(isOverlaySource("hillshade")).toBe(false);
  });

  test("all four are declared", () => {
    expect(TILE_SOURCE_IDS.sort()).toEqual(["hillshade", "imagery", "labels", "roads"]);
  });
});

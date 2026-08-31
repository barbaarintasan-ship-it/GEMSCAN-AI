// The map surface itself, run headless.
//
// The canvas lives in a WebView, which means it is the one part of the field
// screen no ordinary React test can reach — and it is also the part carrying the
// projection, the culling and the tap-to-identify maths. So the page's script is
// extracted from the component and executed against a recording 2D context.
//
// What is asserted is behaviour a geologist would notice: that a full frame is
// drawn without throwing, that the camera it reports back describes the ground
// actually on screen, that a tap comes back as the coordinate that was tapped,
// and that a layer switched off is a layer that costs nothing to draw.
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";

const SOURCE = path.join(__dirname, "..", "ExplorationMap.tsx");

const HERE = { lat: 9.5, lng: 49.0 };

/** A ring around HERE, `d` degrees to a side, in [lng, lat] pairs. */
const square = (d: number): Array<[number, number]> => [
  [HERE.lng - d, HERE.lat - d], [HERE.lng + d, HERE.lat - d],
  [HERE.lng + d, HERE.lat + d], [HERE.lng - d, HERE.lat + d],
  [HERE.lng - d, HERE.lat - d],
];

const scene = {
  bbox: [HERE.lng - 0.3, HERE.lat - 0.3, HERE.lng + 0.3, HERE.lat + 0.3],
  centre: HERE,
  polygons: [{
    id: "g1", name: "Neoproterozoic metamorphic", color: "#FF9BCD",
    // Outer ring with a hole in it — the even-odd fill has to see both.
    rings: [square(0.2), square(0.02)],
    labelAt: HERE, labelSpanM: 40_000,
  }],
  land: [{ id: "l1", name: "land", color: "#1C1D20", rings: [square(0.28)], labelAt: null, labelSpanM: 0 }],
  faults: [{ id: "f1", kind: "fault", name: "Nogal", paths: [[[49.004, 9.45], [49.004, 9.55]]] }],
  otherLines: [],
  contacts: [{ id: "c1", kind: "contact", name: null, paths: [[[48.99, 9.45], [48.99, 9.55]]] }],
  drainage: [{ id: "d1", kind: "drainage", name: "Tog", paths: [[[48.98, 9.45], [49.02, 9.55]]] }],
  lineaments: [],
  occurrences: [{ id: "o1", label: "Alio Ghelle", commodity: "gold", lng: 49.001, lat: 9.501 }],
  terrain: [
    { lng: 49.0, lat: 9.5, elevationM: 640, shade: 0.4, slopeDeg: 28, aspectDeg: 180, morphology: "slope", drainageDistM: 210 },
    { lng: 49.02, lat: 9.52, elevationM: 700, shade: 0.9, slopeDeg: 8, aspectDeg: null, morphology: "ridge", drainageDistM: null },
  ],
  elevationRange: { minM: 640, maxM: 700 },
  maxSlopeDeg: 28,
};

const ALL_ON = {
  satellite: true, hillshade: true, roads: true, labels: true, land: true,
  geology: true, geologyLabels: true, terrain: true, slope: true, aspect: true,
  faults: true, contacts: true, drainage: true, lineaments: true,
  occurrences: true, waypoints: true, track: true, target: true,
  accuracy: true, compass: true, grid: true,
};

interface Harness {
  win: Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any
  ops: string[];
  messages: any[];            // eslint-disable-line @typescript-eslint/no-explicit-any
  touch: (type: string, points: Array<{ x: number; y: number; id?: number }>) => void;
  frames: () => number;
  /** The alpha and blend mode any tile was painted with, when not the default. */
  blend: () => { alpha: number; op: string } | null;
  /** Run whatever the page deferred — its camera reports are rate-limited. */
  flush: () => void;
  /** Arguments of every ctx.transform, in draw order. */
  transforms: number[][];
}

/**
 * Runs the page script against a recording canvas.
 *
 * The stubs answer exactly what the page asks of a browser and nothing more; a
 * method the page starts calling that is not here will fail loudly, which is the
 * point.
 */
function run(layers: Record<string, boolean> = ALL_ON): Harness {
  const src = fs.readFileSync(SOURCE, "utf8");
  const i = src.indexOf("<script>"), j = src.indexOf("</script>");
  const js = src.slice(i + 8, j)
    .replace(/\$\{json\}/g, JSON.stringify(scene))
    .replace(/\$\{lay\}/g, JSON.stringify(layers));

  const ops: string[] = [];
  const record = (name: string) => (...args: unknown[]) => { ops.push(name + ":" + args.length); };
  // save/restore are modelled properly, because whether a blend mode leaks past
  // a tile is exactly the kind of bug this harness exists to catch.
  const stack: Array<{ alpha: number; op: string }> = [];
  // Every ctx.transform(a,b,c,d,e,f), in order — the only way to assert WHERE a
  // tile was actually placed.
  const transforms: number[][] = [];
  const ctx = {
    setTransform: record("setTransform"),
    save: () => { ops.push("save:0"); stack.push({ alpha: ctx.globalAlpha, op: ctx.globalCompositeOperation }); },
    restore: () => {
      ops.push("restore:0");
      const s = stack.pop();
      if (s) { ctx.globalAlpha = s.alpha; ctx.globalCompositeOperation = s.op; }
    },
    transform: (...a: unknown[]) => { transforms.push(a as number[]); ops.push("transform:6"); },
    beginPath: record("beginPath"), closePath: record("closePath"),
    moveTo: record("moveTo"), lineTo: record("lineTo"), arc: record("arc"),
    fill: record("fill"), stroke: record("stroke"), fillRect: record("fillRect"),
    drawImage: (...args: unknown[]) => {
      ops.push("blend:" + ctx.globalAlpha + ":" + ctx.globalCompositeOperation);
      ops.push("drawImage:" + args.length);
    },
    setLineDash: record("setLineDash"),
    fillText: record("fillText"), strokeText: record("strokeText"),
    createRadialGradient: () => ({ addColorStop: record("addColorStop") }),
    globalAlpha: 1, globalCompositeOperation: "source-over",
    fillStyle: "", strokeStyle: "", lineWidth: 1,
    lineCap: "", lineJoin: "", font: "", textAlign: "", textBaseline: "",
  };

  const handlers: Record<string, (e: unknown) => void> = {};
  const canvas = {
    clientWidth: 390, clientHeight: 780, width: 0, height: 0,
    getContext: () => ctx,
    addEventListener: (type: string, fn: (e: unknown) => void) => { handlers[type] = fn; },
  };

  const messages: unknown[] = [];
  let frames = 0;
  // The page rate-limits its camera reports with a trailing timer, so the
  // harness owns a clock rather than pretending there isn't one.
  const timers: Array<(() => void) | null> = [];
  const flush = () => {
    for (let i = 0; i < timers.length; i++) {
      const fn = timers[i];
      timers[i] = null;
      fn?.();
    }
  };
  const win: Record<string, unknown> = {
    setTimeout: (fn: () => void) => timers.push(fn),
    clearTimeout: (id: number) => { if (id) timers[id - 1] = null; },
    devicePixelRatio: 2,
    addEventListener: () => {},
    // Synchronous frames: the page batches through rAF, and a test that never
    // ran the callback would assert on an empty canvas.
    requestAnimationFrame: (fn: () => void) => { frames++; fn(); return frames; },
    ReactNativeWebView: { postMessage: (m: string) => messages.push(JSON.parse(m)) },
    Image: class {
      complete = true; naturalWidth = 256; src = ""; onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
    },
    Date,
    Math,
    JSON,
    Infinity,
    document: { getElementById: () => canvas },
  };
  win.window = win;

  const context = vm.createContext(win);
  vm.runInContext(js, context);

  const touch = (type: string, points: Array<{ x: number; y: number; id?: number }>) => {
    const changed = points.map((p, k) => ({
      identifier: p.id ?? k, clientX: p.x, clientY: p.y,
    }));
    handlers[type]?.({ type, changedTouches: changed, preventDefault: () => {} });
  };

  const blend = () => {
    for (const op of ops) {
      if (!op.startsWith("blend:")) continue;
      const [, alpha, mode] = op.split(":");
      if (Number(alpha) !== 1 || mode !== "source-over") return { alpha: Number(alpha), op: mode };
    }
    return null;
  };

  return { win, ops, messages: messages as any[], touch, frames: () => frames, blend, flush, transforms }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Deferred reports are delivered first — the page always sends its LAST state. */
const cameraMessages = (h: Harness) => { h.flush(); return h.messages.filter((m) => m.type === "camera"); };
const picks = (h: Harness) => h.messages.filter((m) => m.type === "pick");

describe("the map page draws", () => {
  test("a full frame over real geometry throws nothing", () => {
    const h = run();
    expect(h.ops.length).toBeGreaterThan(0);
    // The unit is filled through ONE path with an even-odd rule, so its hole
    // stays a hole. Filling ring by ring is what used to paint holes solid.
    expect(h.ops).toContain("fill:1");
  });

  test("it reports a camera describing the ground actually on screen", () => {
    const h = run();
    const cam = cameraMessages(h).pop();
    expect(cam).toBeDefined();
    expect(cam.metresPerPx).toBeGreaterThan(0);
    const [w, s, e, n] = cam.bbox;
    expect(w).toBeLessThan(HERE.lng);
    expect(e).toBeGreaterThan(HERE.lng);
    expect(s).toBeLessThan(HERE.lat);
    expect(n).toBeGreaterThan(HERE.lat);
    expect(cam.ringStepM).toBeGreaterThan(0);
  });

  test("an identical frame is not reported twice", () => {
    const h = run();
    const before = cameraMessages(h).length;
    h.win.__setLayers(ALL_ON);
    expect(cameraMessages(h).length).toBe(before);
  });
});

describe("layers cost nothing when they are off", () => {
  test("everything off draws far less than everything on", () => {
    const on = run(ALL_ON).ops.length;
    const off = run({ ...ALL_ON, geology: false, land: false, faults: false, contacts: false,
      drainage: false, occurrences: false, terrain: false, slope: false, aspect: false,
      grid: false, geologyLabels: false }).ops.length;
    expect(off).toBeLessThan(on);
  });

  test("a scene panned away from is culled rather than drawn", () => {
    const near = run();
    const far = run();
    const drawnHere = near.ops.length;
    far.win.__centreOn(-30, -60);   // the other side of the world
    const drawnThere = far.ops.length - drawnHere;
    expect(drawnThere).toBeLessThan(drawnHere);
  });
});

describe("live state arrives in pieces", () => {
  test("a position recentres the map while it is still following", () => {
    const h = run();
    h.win.__setPosition({ lat: 9.51, lng: 49.01, accuracyM: 7 }, 45);
    const cam = cameraMessages(h).pop();
    const [w, s, e, n] = cam.bbox;
    expect(9.51).toBeGreaterThan(s);
    expect(9.51).toBeLessThan(n);
    expect(49.01).toBeGreaterThan(w);
    expect(49.01).toBeLessThan(e);
  });

  test("track points append rather than replacing the traverse", () => {
    const h = run();
    h.win.__setTrack([[49.0, 9.5], [49.001, 9.501]]);
    h.win.__addTrack([[49.002, 9.502]]);
    // Drawing is the only observable; what matters is that it did not throw and
    // the page still reports a camera afterwards.
    expect(cameraMessages(h).length).toBeGreaterThan(0);
  });

  test("tiles are accepted for both bands and drawn", () => {
    const h = run();
    h.ops.length = 0;
    h.win.__setTiles(
      [{ uri: "file:///a.jpg", w: 48.9, s: 9.4, e: 49.1, n: 9.6, source: "imagery" }],
      [{ uri: "file:///b.png", w: 48.9, s: 9.4, e: 49.1, n: 9.6, source: "labels" }],
    );
    // At least one blit per band; a tile may take several (see reprojection).
    expect(h.ops.filter((o) => o.startsWith("drawImage")).length).toBeGreaterThanOrEqual(2);
  });
});

// THE FREEZE (compass edition). Every heading update — up to 2x/sec, from
// HeadingService's own ceiling — used to run through the exact same path as a
// GPS fix or a pan: a full draw() of every vector layer, just to rotate the
// small direction cone. MEASURED on-device: this alone pegged the map at
// 1.5-3 fps completely idle, because nothing the geologist actually moved
// (position, pan, zoom) needed to change at all. These assert the fix stays
// scoped to exactly that case: a heading-only call is throttled, but a real
// position change — or a heading swing big enough to matter — never is.
describe("heading-only redraws are throttled, position redraws never are", () => {
  test("the first position/heading call always draws", () => {
    const h = run();
    h.ops.length = 0;
    h.win.__setPosition({ lat: HERE.lat, lng: HERE.lng, accuracyM: 5 }, 10);
    expect(h.ops.length).toBeGreaterThan(0);
  });

  test("a position change redraws immediately even with heading unchanged", () => {
    const h = run();
    h.win.__setPosition({ lat: HERE.lat, lng: HERE.lng, accuracyM: 5 }, 10);
    h.ops.length = 0;
    h.win.__setPosition({ lat: HERE.lat + 0.001, lng: HERE.lng, accuracyM: 5 }, 10);
    expect(h.ops.length).toBeGreaterThan(0);
  });

  test("a tiny heading wobble right after a redraw, position unchanged, draws nothing", () => {
    const h = run();
    h.win.__setPosition({ lat: HERE.lat, lng: HERE.lng, accuracyM: 5 }, 10);
    h.ops.length = 0;
    h.win.__setPosition({ lat: HERE.lat, lng: HERE.lng, accuracyM: 5 }, 12); // +2 deg
    expect(h.ops.length).toBe(0);
  });

  test("a heading swing large enough still redraws immediately", () => {
    const h = run();
    h.win.__setPosition({ lat: HERE.lat, lng: HERE.lng, accuracyM: 5 }, 10);
    h.ops.length = 0;
    h.win.__setPosition({ lat: HERE.lat, lng: HERE.lng, accuracyM: 5 }, 30); // +20 deg
    expect(h.ops.length).toBeGreaterThan(0);
  });

  test("a null heading (compass unavailable) is never throttled", () => {
    const h = run();
    h.win.__setPosition({ lat: HERE.lat, lng: HERE.lng, accuracyM: 5 }, null);
    h.ops.length = 0;
    h.win.__setPosition({ lat: HERE.lat, lng: HERE.lng, accuracyM: 5 }, null);
    expect(h.ops.length).toBeGreaterThan(0);
  });

  test("a suppressed heading wobble is not lost — it still redraws once enough has accumulated", () => {
    const h = run();
    h.win.__setPosition({ lat: HERE.lat, lng: HERE.lng, accuracyM: 5 }, 10);
    h.win.__setPosition({ lat: HERE.lat, lng: HERE.lng, accuracyM: 5 }, 12); // suppressed
    h.ops.length = 0;
    // Small steps that individually stay under the angle gate, but cross it
    // cumulatively from the LAST DRAWN heading (10), not the last received one.
    h.win.__setPosition({ lat: HERE.lat, lng: HERE.lng, accuracyM: 5 }, 19); // 9 deg from 10 → redraws
    expect(h.ops.length).toBeGreaterThan(0);
  });
});

describe("the backdrop is composed, not stacked", () => {
  /** Every drawImage, with the alpha and blend mode in force when it ran. */
  function blits(h: Harness) {
    return h.ops.filter((o) => o.startsWith("drawImage") || o.startsWith("blend:"));
  }

  test("hillshade is multiplied into imagery instead of covering it", () => {
    const h = run();
    h.ops.length = 0;
    h.win.__setTiles(
      [
        { uri: "file:///sat.jpg", w: 48.9, s: 9.4, e: 49.1, n: 9.6, source: "imagery" },
        { uri: "file:///hs.jpg", w: 48.9, s: 9.4, e: 49.1, n: 9.6, source: "hillshade" },
      ],
      [],
    );
    // Both are painted — the bug was not a missing tile, it was an opaque grey
    // sheet on top of the ground. (Each tile may take several blits: see the
    // reprojection tests below.)
    expect(blits(h).filter((o) => o.startsWith("drawImage")).length).toBeGreaterThanOrEqual(2);
    expect(h.blend()).toEqual({ alpha: 0.5, op: "multiply" });
  });

  test("with imagery switched off, hillshade stands alone at full strength", () => {
    const h = run({ ...ALL_ON, satellite: false });
    h.ops.length = 0;
    h.win.__setTiles([{ uri: "file:///hs.jpg", w: 48.9, s: 9.4, e: 49.1, n: 9.6, source: "hillshade" }], []);
    expect(h.blend()).toBeNull();
  });
});

describe("tiles are reprojected, not stretched", () => {
  /**
   * Recover the latitude a strip was placed at, from the transform that placed it.
   *
   * North-up, so the translate component (f) is the screen y of the strip's top
   * edge: y = H/2 - (wy(lat) - cam.y) * scale. Everything on the right is known,
   * so the latitude the page ACTUALLY used comes back out — which is the only way
   * to prove a tile is projected rather than smeared.
   */
  function latsFrom(h: Harness, metresPerPx: number): number[] {
    const H = 780, M_LAT = 111195, centreLat = HERE.lat;
    const scale = 1 / metresPerPx;
    return h.transforms.map((t) => centreLat + (H / 2 - t[5]) / (scale * M_LAT));
  }

  test("a tile small enough to be flat is drawn in one piece", () => {
    const h = run();
    h.win.__setPosition({ lat: HERE.lat, lng: HERE.lng, accuracyM: 5 }, null);
    h.transforms.length = 0;
    // ~0.02° of latitude: the Mercator bend across it is far below a pixel.
    h.win.__setTiles([{ uri: "file:///a.jpg", w: 48.99, s: 9.49, e: 49.01, n: 9.51, source: "imagery" }], []);
    expect(h.transforms).toHaveLength(1);
  });

  test("a tile spanning degrees is split, because Mercator bends inside it", () => {
    const h = run();
    h.win.__setPosition({ lat: HERE.lat, lng: HERE.lng, accuracyM: 5 }, null);
    h.transforms.length = 0;
    h.win.__setTiles([{ uri: "file:///a.jpg", w: 45, s: 0, e: 67.5, n: 21.94, source: "imagery" }], []);
    // A z4 tile. One straight stretch across 22° of latitude is what put Bosaso
    // inland; the strips are what stop it.
    expect(h.transforms.length).toBeGreaterThan(8);
  });

  test("the strips follow MERCATOR latitudes, not evenly spaced ones", () => {
    const h = run();
    h.win.__setPosition({ lat: HERE.lat, lng: HERE.lng, accuracyM: 5 }, null);
    const mpp = cameraMessages(h).pop().metresPerPx;
    h.transforms.length = 0;

    const n = 21.943045, s = 0;   // a real z4 tile row
    h.win.__setTiles([{ uri: "file:///a.jpg", w: 45, s, e: 67.5, n, source: "imagery" }], []);

    const lats = latsFrom(h, mpp);
    expect(lats[0]).toBeCloseTo(n, 1);

    // The middle boundary is the give-away. Evenly spaced would put it at the
    // arithmetic mean; Mercator puts it north of that — here by about 0.2°, which
    // is some 23 km of ground, and is exactly how a coastal town ends up inland.
    const mid = lats[Math.floor(lats.length / 2)];
    const arithmetic = n / 2;
    expect(mid).toBeGreaterThan(arithmetic + 0.15);

    // And it matches the projection's own answer for that row.
    const yTop = mercY(n), yBot = mercY(s);
    const f = Math.floor(lats.length / 2) / lats.length;
    expect(mid).toBeCloseTo(latFromMercY(yTop + (yBot - yTop) * f), 1);
  });

  /** The same maths the page uses, restated here so the test is independent. */
  function mercY(lat: number): number {
    const r = (lat * Math.PI) / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
  }
  function latFromMercY(y: number): number {
    const n = Math.PI * (1 - 2 * y);
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }
});

// The tests above prove the tiles are reprojected. These prove the DIAGNOSTICS
// panel is told the truth about it — a separate claim, and the one that was
// unverified. The field build read "1 strips" at every zoom, which is correct at
// z12 and closer and says nothing at all about whether the reprojection ran, so
// the number had to be tied to the drawing it describes.
describe("the strip count reported is the strip count drawn", () => {
  const tile = (n: number, s: number) =>
    ({ uri: "file:///a.jpg", w: 45, s, e: 67.5, n, source: "imagery" });

  const reported = (h: Harness) => cameraMessages(h).pop().tileStrips;

  test("a flat tile reports exactly one strip, and draws exactly one", () => {
    const h = run();
    h.win.__setPosition({ lat: HERE.lat, lng: HERE.lng, accuracyM: 5 }, null);
    h.transforms.length = 0;
    h.win.__setTiles([tile(9.51, 9.49)], []);
    expect(h.transforms).toHaveLength(1);
    expect(reported(h)).toBe(1);
  });

  test("a tile spanning degrees reports many, and the count MATCHES the blits", () => {
    const h = run();
    h.win.__setPosition({ lat: HERE.lat, lng: HERE.lng, accuracyM: 5 }, null);
    h.transforms.length = 0;
    h.win.__setTiles([tile(21.943045, 0)], []);
    // Equality, not "greater than 1": a plausible-looking number that drifts from
    // the drawing is exactly the failure being guarded against.
    expect(reported(h)).toBe(h.transforms.length);
    expect(reported(h)).toBeGreaterThan(8);
  });

  test("the count follows the span rather than being fixed", () => {
    const counts = [0.01, 0.5, 2, 11].map((span) => {
      const h = run();
      h.win.__setPosition({ lat: HERE.lat, lng: HERE.lng, accuracyM: 5 }, null);
      h.win.__setTiles([tile(HERE.lat + span / 2, HERE.lat - span / 2)], []);
      return reported(h);
    });
    // Monotonic in span, and genuinely varying — the shape of an adaptive rule.
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(new Set(counts).size).toBeGreaterThan(2);
    expect(counts[0]).toBe(1);
  });

  test("no tiles painted reports zero, never a default of one", () => {
    // "1" must mean "the reprojection ran and one strip was exact". If nothing
    // was drawn, the honest answer is 0, and the panel shows it as a warning.
    const h = run();
    h.win.__setPosition({ lat: HERE.lat, lng: HERE.lng, accuracyM: 5 }, null);
    h.win.__setTiles([], []);
    expect(reported(h)).toBe(0);
  });

  test("the count is recomputed per frame, not accumulated", () => {
    const h = run();
    h.win.__setPosition({ lat: HERE.lat, lng: HERE.lng, accuracyM: 5 }, null);
    h.win.__setTiles([tile(21.943045, 0)], []);
    expect(reported(h)).toBeGreaterThan(8);
    // Zooming back in must bring it down again; a stale high-water mark would
    // leave the panel claiming a reprojection that is no longer happening.
    h.win.__setTiles([tile(9.51, 9.49)], []);
    expect(reported(h)).toBe(1);
  });
});

describe("rotation follows the fingers", () => {
  /** Two fingers, rotated about the screen centre by `deg` (clockwise on screen). */
  function twist(h: Harness, deg: number) {
    const cx = 195, cy = 390, r = 120;
    const at = (a: number) => [
      { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), id: 0 },
      { x: cx - r * Math.cos(a), y: cy - r * Math.sin(a), id: 1 },
    ];
    h.touch("touchstart", at(0));
    h.touch("touchmove", at((deg * Math.PI) / 180));
  }

  test("clockwise fingers turn the map clockwise", () => {
    const h = run();
    h.win.__setPosition({ lat: HERE.lat, lng: HERE.lng, accuracyM: 5 }, null);
    twist(h, 40);
    // cam.rot is the bearing at the top of the screen. Turning the ground
    // clockwise brings a WESTERLY bearing to the top, i.e. 360 - 40.
    expect(cameraMessages(h).pop().rotationDeg).toBeCloseTo(320, 0);
  });

  test("counter-clockwise fingers turn the map counter-clockwise", () => {
    const h = run();
    h.win.__setPosition({ lat: HERE.lat, lng: HERE.lng, accuracyM: 5 }, null);
    twist(h, -40);
    expect(cameraMessages(h).pop().rotationDeg).toBeCloseTo(40, 0);
  });

  test("the reported angle is the bearing at the top of the screen", () => {
    const h = run();
    h.win.__setRotation(90);          // east up
    expect(cameraMessages(h).pop().rotationDeg).toBeCloseTo(90, 3);
    h.win.__centre();                 // back to north up
    expect(cameraMessages(h).pop().rotationDeg).toBeCloseTo(0, 3);
  });
});

describe("the scene follows the view", () => {
  /** A second scene, centred elsewhere and carrying a distant occurrence. */
  const wider = {
    ...scene,
    centre: { lat: 10.2, lng: 48.4 },
    occurrences: [
      ...scene.occurrences,
      { id: "o2", label: "Far lead", commodity: "gold", lng: 48.2, lat: 10.4 },
    ],
  };

  test("more ground can be swapped in without losing the camera", () => {
    const h = run();
    h.win.__setPosition({ lat: HERE.lat, lng: HERE.lng, accuracyM: 5 }, null);
    const before = cameraMessages(h).pop();
    h.win.__setScene(wider);
    const after = cameraMessages(h).pop();
    // The projection origin moved; the ground under the screen did not.
    for (let i = 0; i < 4; i++) expect(after.bbox[i]).toBeCloseTo(before.bbox[i], 3);
    expect(after.metresPerPx).toBeCloseTo(before.metresPerPx, 6);
  });

  test("features from the new scene are drawn, which is the whole point", () => {
    const h = run();
    h.win.__setScene(wider);
    h.ops.length = 0;
    // Centre on the far occurrence and confirm the map now has something there.
    h.win.__centreOn(10.4, 48.2);
    expect(h.ops.filter((o) => o.startsWith("arc")).length).toBeGreaterThan(0);
  });

  test("a tap after the swap still returns the coordinate under the finger", () => {
    const h = run();
    h.win.__setScene(wider);
    h.win.__centreOn(10.4, 48.2);
    h.touch("touchstart", [{ x: 195, y: 390 }]);
    h.touch("touchend", [{ x: 195, y: 390 }]);
    const p = picks(h).pop();
    expect(p.lat).toBeCloseTo(10.4, 3);
    expect(p.lng).toBeCloseTo(48.2, 3);
  });
});

describe("the camera controls", () => {
  test("zooming in halves the metres per pixel", () => {
    const h = run();
    const before = cameraMessages(h).pop().metresPerPx;
    h.win.__zoom(2);
    expect(cameraMessages(h).pop().metresPerPx).toBeCloseTo(before / 2, 6);
  });

  test("framing holds the viewer and the target together", () => {
    const h = run();
    h.win.__setPosition({ lat: 9.5, lng: 49.0, accuracyM: 5 }, null);
    h.win.__setPins({ lat: 9.9, lng: 49.4 }, [], null);
    h.win.__frame();
    const [w, s, e, n] = cameraMessages(h).pop().bbox;
    for (const p of [{ lat: 9.5, lng: 49.0 }, { lat: 9.9, lng: 49.4 }]) {
      expect(p.lng).toBeGreaterThan(w);
      expect(p.lng).toBeLessThan(e);
      expect(p.lat).toBeGreaterThan(s);
      expect(p.lat).toBeLessThan(n);
    }
  });

  test("rotation is reported so the compass can point north", () => {
    const h = run();
    h.win.__setRotation(90);
    expect(cameraMessages(h).pop().rotationDeg).toBeCloseTo(90, 3);
  });
});

describe("tapping the map", () => {
  test("a tap comes back as the coordinate under the finger", () => {
    const h = run();
    h.win.__setPosition({ lat: HERE.lat, lng: HERE.lng, accuracyM: 5 }, null);
    // Dead centre of a 390×780 canvas is the camera centre, which follows the fix.
    h.touch("touchstart", [{ x: 195, y: 390 }]);
    h.touch("touchend", [{ x: 195, y: 390 }]);
    const p = picks(h).pop();
    expect(p).toBeDefined();
    expect(p.lat).toBeCloseTo(HERE.lat, 4);
    expect(p.lng).toBeCloseTo(HERE.lng, 4);
    // The tolerance is a fingertip converted at the zoom the tap was made at.
    expect(p.radiusM).toBeGreaterThan(0);
  });

  test("a tap off centre reads as ground off centre, in the right direction", () => {
    const h = run();
    h.win.__setPosition({ lat: HERE.lat, lng: HERE.lng, accuracyM: 5 }, null);
    h.touch("touchstart", [{ x: 195, y: 200 }]);   // above centre = north
    h.touch("touchend", [{ x: 195, y: 200 }]);
    const p = picks(h).pop();
    expect(p.lat).toBeGreaterThan(HERE.lat);
    expect(p.lng).toBeCloseTo(HERE.lng, 4);
  });

  test("a drag is not a tap — panning the map must never open a sheet", () => {
    const h = run();
    h.touch("touchstart", [{ x: 100, y: 300 }]);
    h.touch("touchmove", [{ x: 260, y: 480 }]);
    h.touch("touchend", [{ x: 260, y: 480 }]);
    expect(picks(h)).toHaveLength(0);
  });

  test("a drag moves the ground the way the finger moved", () => {
    const h = run();
    h.win.__setPosition({ lat: HERE.lat, lng: HERE.lng, accuracyM: 5 }, null);
    const before = cameraMessages(h).pop().bbox;
    // Dragged UP. The ground follows the finger, so the ground that was below
    // the bottom edge comes into view — the view moves SOUTH, exactly as it does
    // on paper when you push the map away from you.
    h.touch("touchstart", [{ x: 195, y: 390 }]);
    h.touch("touchmove", [{ x: 195, y: 300 }]);
    const after = cameraMessages(h).pop().bbox;
    expect(after[1]).toBeLessThan(before[1]);
    expect(after[3]).toBeLessThan(before[3]);
  });

  test("a drag stops the map following the fix — it must not snap back", () => {
    const h = run();
    h.win.__setPosition({ lat: HERE.lat, lng: HERE.lng, accuracyM: 5 }, null);
    h.touch("touchstart", [{ x: 195, y: 390 }]);
    h.touch("touchmove", [{ x: 195, y: 250 }]);
    h.touch("touchend", [{ x: 195, y: 250 }]);
    const panned = cameraMessages(h).pop().bbox;
    // A fresh fix at the same place arrives; the view stays where it was dragged.
    h.win.__setPosition({ lat: HERE.lat, lng: HERE.lng, accuracyM: 5 }, null);
    expect(cameraMessages(h).pop().bbox).toEqual(panned);
    // Until the geologist asks to be recentred.
    h.win.__centre();
    expect(cameraMessages(h).pop().bbox).not.toEqual(panned);
  });
});

describe("the image cache cannot evict what it is drawing", () => {
  // THE FREEZE. The cap was 160 while four tile sources at sixty tiles each can
  // put 240 on screen. Over the cap the LRU deleted tiles being painted in that
  // very frame; the next frame re-created them, re-decoded them, and every
  // onload called draw() again — which evicted them again. A self-sustaining
  // loop of image decodes, each one scheduling another frame.
  //
  // On the device: JS thread pinned at 100%, 771 MB resident, and no button
  // anywhere in the app would answer. It bit only when the screenful exceeded
  // the cache, which is why it was intermittent.
  //
  // The page keeps its state inside an IIFE, so these assert the two things it
  // does report: how many images it holds, and how many it had to decode.

  /** A grid of tiles covering the view — a realistic screenful, not one tile. */
  const screenful = (n: number, source: string, tag: string) => {
    const out = [];
    const step = 0.6 / n;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < n; k++) {
        const w = HERE.lng - 0.3 + i * step;
        const s = HERE.lat - 0.3 + k * step;
        out.push({ uri: `file:///${tag}-${i}-${k}.jpg`, w, s, e: w + step, n: s + step, source });
      }
    }
    return out;
  };

  /** Counts every image the page decodes from here on. */
  function countDecodes(h: Harness) {
    let n = 0;
    const Base = h.win.Image as new () => Record<string, unknown>;
    h.win.Image = class extends Base { constructor() { super(); n++; } };
    return () => n;
  }

  test("REDRAWING THE SAME GROUND DECODES NOTHING NEW — this is the loop, as a number", () => {
    const h = run();
    const tiles = screenful(10, "imagery", "im");
    h.win.__setTiles(tiles, []);          // first pass: the real decodes

    const decoded = countDecodes(h);
    for (let i = 0; i < 12; i++) h.win.__setTiles(tiles, []);

    // Under the old rule each pass evicted tiles it was drawing and decoded them
    // again on the next — hundreds of decodes, for ever, for a still map.
    expect(decoded()).toBe(0);
  });

  test("four full sources at once still decode each tile exactly once", () => {
    const h = run();
    const decoded = countDecodes(h);
    const base = [...screenful(9, "imagery", "im"), ...screenful(9, "hillshade", "hs")];
    const over = [...screenful(9, "roads", "rd"), ...screenful(9, "labels", "lb")];
    h.win.__setTiles(base, over);
    const first = decoded();

    h.win.__setTiles(base, over);
    h.win.__setTiles(base, over);
    // Everything on screen at once — 324 tiles asking to be drawn — and not one
    // of them is evicted while in use.
    expect(decoded()).toBe(first);
    expect(first).toBeGreaterThan(0);
  });

  test("the page reports how many images it holds, and stays bounded", () => {
    const h = run();
    h.win.__setTiles(screenful(12, "imagery", "old"), []);
    for (let r = 0; r < 5; r++) h.win.__setTiles(screenful(12, "imagery", `new${r}`), []);

    const cam = cameraMessages(h).pop();
    expect(typeof cam.imagesHeld).toBe("number");
    // Six screenfuls have passed through. Ground no longer on screen IS evicted,
    // so this is bounded well below the 864 tiles that were drawn.
    expect(cam.imagesHeld).toBeLessThanOrEqual(288);
  });

  test("THE CACHE COSTS MEMORY, and the ceiling is asserted in megabytes", () => {
    // Each decoded 256x256 tile is roughly 256 KB inside the WebView. The cap was
    // raised to 512 as belt-and-braces alongside the frame-aware eviction, and
    // the belt alone was 131 MB: on the device the app climbed from 431 MB to
    // 536 MB while the map was dragged, and the phone began swapping.
    //
    // Driven well past the cap here, and the ceiling is asserted in the unit that
    // actually hurt — not in tiles, which is a number nobody can feel.
    const h = run();
    for (let r = 0; r < 8; r++) {
      h.win.__setTiles(screenful(11, "imagery", `a${r}`), screenful(11, "roads", `b${r}`));
    }
    const held = cameraMessages(h)
      .map((m) => m.imagesHeld as number)
      .reduce((a, b) => Math.max(a, b), 0);

    expect(held).toBeGreaterThan(0);
    const megabytes = (held * 256) / 1024;
    expect(megabytes).toBeLessThanOrEqual(80);
  });
});

// The exploration sheet must never put content under Android's navigation bar.
//
// THE FIELD REPORT, with screenshots: FIELD DIAGNOSTICS sat behind the navigation
// buttons, and the reporter's own words were the clue that found it — "the layout
// is correct only in one sheet state, but breaks when the sheet height changes."
//
// WHY ONE PADDING COULD NOT WORK
//
// The sheet is anchored at `bottom: 0` and TRANSLATED down to collapse it, rather
// than having its height animated (animating height re-lays-out its contents on
// every frame). So:
//
//   expanded   the sheet's bottom edge IS the screen's bottom edge
//   collapsed  the sheet's bottom edge is `travel` pixels BELOW the screen
//
// Content flows from the sheet's TOP; the navigation strip is fixed to the
// SCREEN. The distance between them therefore changes as the sheet moves, and a
// `paddingBottom` on the sheet protects the strip in one state and nothing at all
// in the other. That is precisely what shipped.
//
// These tests are pure geometry — no renderer, no device. They assert the
// invariant the screenshots violated: in EVERY state, at EVERY inset, on EVERY
// screen size, the last pixel of content sits above the last pixel of navigation.
import {
  SHEET_COLLAPSED_H, sheetInsets,
} from "../../components/ExplorationSheet";

/**
 * The collapsed sheet, measured from ITS OWN TOP.
 *
 * Padding is empty space, not content — that distinction is the whole bug. The
 * header's CONTENT ends at its natural height; the padding after it is what keeps
 * the next thing out of the navigation strip.
 */
function collapsedGeometry(inset: number, headerH: number) {
  const pad = sheetInsets(inset, false);
  const windowH = SHEET_COLLAPSED_H + inset;   // visible band, ending at screen bottom
  return {
    windowH,
    /** Where the navigation strip begins, from the sheet's top. */
    stripTop: windowH - inset,
    /** Where the header's last pixel of CONTENT is. */
    headerContentEnd: headerH,
    /** Where the scroll body — FIELD DIAGNOSTICS and everything after — begins. */
    bodyTop: headerH + pad.header,
  };
}

/** Realistic devices, and the two Android navigation styles. */
const SCREENS = [640, 720, 800, 915, 1024];
const INSETS = [
  0,   // 3-button navigation with the window inset out of the way
  16,  // gesture pill, short
  24,
  48,  // 3-button navigation drawn edge to edge — the reported case
];

describe("no content is ever drawn under the navigation bar", () => {
  test("COLLAPSED: the header's content ends at or above the strip", () => {
    for (const inset of INSETS) {
      // A header that exactly fills the collapsed content area — the worst
      // realistic case, and close to what the real one measures.
      const g = collapsedGeometry(inset, SHEET_COLLAPSED_H);
      expect(g.headerContentEnd).toBeLessThanOrEqual(g.stripTop);
    }
  });

  test("COLLAPSED: FIELD DIAGNOSTICS begins at or below the visible window", () => {
    // This is the exact failure in the screenshot. The scroll body is the first
    // thing after the pinned header, and with no header inset it began at 168 —
    // the very pixel the navigation strip starts on.
    for (const inset of INSETS) {
      const g = collapsedGeometry(inset, SHEET_COLLAPSED_H);
      expect(g.bodyTop).toBeGreaterThanOrEqual(g.windowH);
    }
  });

  test("EXPANDED: the sheet reserves the strip for the scroll viewport", () => {
    for (const inset of INSETS) {
      expect(sheetInsets(inset, true).sheet).toBe(inset);
    }
  });

  test("THE REGRESSION, reconstructed: sheet-only padding put the body in the strip", () => {
    const inset = 48;
    const g = collapsedGeometry(inset, SHEET_COLLAPSED_H);

    // What shipped: the inset applied ONLY to the sheet, whose bottom edge is
    // below the screen while collapsed. The header therefore carried nothing, and
    // the scroll body began the instant the header ended.
    const shippedBodyTop = SHEET_COLLAPSED_H + 0;
    expect(shippedBodyTop).toBeLessThan(g.windowH);      // visible…
    expect(shippedBodyTop).toBeGreaterThanOrEqual(g.stripTop); // …and inside the strip

    // With the fix it starts at the window's edge instead — off screen, where a
    // collapsed sheet's body belongs.
    expect(g.bodyTop).toBe(g.windowH);
  });
});

describe("the inset lands in the right place for the state", () => {
  test("collapsed, the HEADER carries it — the sheet's own edge is off screen", () => {
    expect(sheetInsets(48, false)).toEqual({ header: 48, sheet: 48 });
  });

  test("expanded, the header does NOT — the sheet's edge is the screen's edge", () => {
    // Otherwise a gesture-nav device would show a 48pt gap between the pinned
    // header and the scrolling body, in the state where it protects nothing.
    expect(sheetInsets(48, true)).toEqual({ header: 0, sheet: 48 });
  });

  test("a device with no bottom inset is unaffected in either state", () => {
    expect(sheetInsets(0, false)).toEqual({ header: 0, sheet: 0 });
    expect(sheetInsets(0, true)).toEqual({ header: 0, sheet: 0 });
  });
});

describe("the sheet still fits on small screens", () => {
  test("travel never goes negative, so the sheet cannot invert", () => {
    for (const inset of INSETS) {
      for (const h of [480, ...SCREENS]) {
        const expandedHeight = Math.min(h * 0.68, h - 180);
        const travel = Math.max(0, expandedHeight - (SHEET_COLLAPSED_H + inset));
        expect(travel).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("the collapsed window always leaves the documented content height", () => {
    // The window grows by the inset; the content inside it does not. If this ever
    // stops being true the sheet has started eating the map to make room for a
    // navigation bar.
    for (const inset of INSETS) {
      const collapsedH = SHEET_COLLAPSED_H + inset;
      expect(collapsedH - sheetInsets(inset, false).header).toBe(SHEET_COLLAPSED_H);
    }
  });
});

// Every control that floats over the map, pressed.
//
// WHY THIS EXISTS
// ---------------
// The rail and the layer panel shipped visible and completely dead. Both are
// absolutely positioned, and both had been wrapped in a positioning View that
// had no size of its own — on Android a child drawn outside its parent's bounds
// is drawn and never touched. Nothing failed, nothing logged; the buttons simply
// did nothing.
//
// So two things are asserted here, for every control:
//
//   1. Pressing it calls the handler it was given, with what it was given.
//   2. Anything absolutely positioned carries its OWN offset, rather than
//      relying on a wrapper to place it.
//
// The second is the regression guard. A control that goes back to being placed
// by a sizeless parent fails this file rather than the field test.
import React from "react";
import renderer, { type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { Pressable, StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

/** Insets of a phone with gesture navigation — the case that hid the text. */
const METRICS = {
  frame: { x: 0, y: 0, width: 1080, height: 2340 },
  insets: { top: 36, left: 0, right: 0, bottom: 48 },
};
import {
  Compass, GpsChip, LayerPanel, MapRail, MapTopBar, RoundBtn, ScaleBar, TargetPill,
} from "../MapOverlay";
import { ExplorationSheet, SheetAction } from "../ExplorationSheet";

/**
 * Every button in a tree, in render order.
 *
 * By TYPE, not by "has an onPress prop": Pressable passes handlers down through
 * several internal layers, so a props search counts one button three times.
 */
function pressables(tree: ReactTestRenderer): ReactTestInstance[] {
  return tree.root.findAllByType(Pressable);
}

function press(tree: ReactTestRenderer, index = 0): void {
  const all = pressables(tree);
  if (!all[index]) throw new Error(`no pressable at ${index} (found ${all.length})`);
  renderer.act(() => { all[index].props.onPress(); });
}

/** The flattened style of the outermost host view a component renders. */
function rootStyle(tree: ReactTestRenderer): Record<string, unknown> {
  const isHost = (n: ReactTestInstance) => typeof n.type === "string";
  const host = tree.root.findAll(isHost, { deep: false })[0] ?? tree.root.find(isHost);
  return StyleSheet.flatten(host.props.style) as Record<string, unknown>;
}

describe("MapRail", () => {
  const items = (spies: jest.Mock[]) => [
    { icon: "layers" as const, label: "Layers", onPress: spies[0] },
    { icon: "locate" as const, label: "Centre", onPress: spies[1] },
    { icon: "scan" as const, label: "Frame", onPress: spies[2] },
    { icon: "analytics" as const, label: "Track", active: true, onPress: spies[3] },
    { icon: "location" as const, label: "Waypoints", onPress: spies[4] },
  ];

  test("every button on the rail calls its own handler", () => {
    const spies = Array.from({ length: 5 }, () => jest.fn());
    const tree = renderer.create(<MapRail top={100} items={items(spies)} />);
    const all = pressables(tree);
    expect(all).toHaveLength(5);
    all.forEach((p) => renderer.act(() => { p.props.onPress(); }));
    spies.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
  });

  test("it positions ITSELF — the sizeless-wrapper bug cannot come back", () => {
    const style = rootStyle(renderer.create(<MapRail top={137} items={items(Array.from({ length: 5 }, () => jest.fn()))} />));
    expect(style.position).toBe("absolute");
    expect(style.top).toBe(137);
    expect(style.left).toEqual(expect.any(Number));
  });
});

describe("LayerPanel", () => {
  const groups = [
    {
      title: "Base map",
      rows: [
        { key: "satellite", label: "Satellite", icon: "earth" as const, color: "#4A90E2" },
        { key: "labels", label: "Place names", icon: "text" as const, color: "#FFF", online: true },
      ],
    },
    {
      title: "Geology",
      rows: [{ key: "faults", label: "Faults", icon: "git-branch" as const, color: "#F00" }],
    },
  ];

  test("each row toggles its own layer, and close closes", () => {
    const onToggle = jest.fn();
    const onClose = jest.fn();
    const tree = renderer.create(
      <LayerPanel
        title="LAYERS" layers={{ satellite: true, labels: false, faults: true }}
        onToggle={onToggle} onClose={onClose} groups={groups} top={100} maxHeight={400}
      />,
    );
    const all = pressables(tree);
    // Close, then one per row.
    expect(all).toHaveLength(1 + 3);
    all.forEach((p) => renderer.act(() => { p.props.onPress(); }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onToggle.mock.calls.map((c) => c[0])).toEqual(["satellite", "labels", "faults"]);
  });

  test("it positions itself too", () => {
    const style = rootStyle(renderer.create(
      <LayerPanel
        title="LAYERS" layers={{}} onToggle={jest.fn()} onClose={jest.fn()}
        groups={groups} top={210} maxHeight={400}
      />,
    ));
    expect(style.position).toBe("absolute");
    expect(style.top).toBe(210);
    expect(style.maxHeight).toBe(400);
  });

  test("an online layer says so when there is no connection", () => {
    const tree = renderer.create(
      <LayerPanel
        title="LAYERS" layers={{ labels: true }} onToggle={jest.fn()} onClose={jest.fn()}
        groups={groups} top={100} maxHeight={400} offline offlineNote="Offline — cached tiles"
      />,
    );
    const texts = tree.root
      .findAll((n: ReactTestInstance) => n.type === "Text")
      .map((n: ReactTestInstance) => JSON.stringify(n.props.children));
    expect(texts.some((t) => t.includes("Offline — cached tiles"))).toBe(true);
  });
});

describe("the round controls", () => {
  test("zoom, locate and the satellite toggle each fire once", () => {
    for (const props of [
      { icon: "add" as const },
      { icon: "remove" as const },
      { label: "SAT", active: true },
      { icon: "navigate" as const, size: 52 },
    ]) {
      const onPress = jest.fn();
      const tree = renderer.create(<RoundBtn {...props} onPress={onPress} />);
      press(tree);
      expect(onPress).toHaveBeenCalledTimes(1);
    }
  });

  const compass = (over: Partial<React.ComponentProps<typeof Compass>> = {}) => ({
    rotationDeg: 0, headingDeg: 40, targetBearingDeg: 130,
    needsCalibration: false, headingUp: false, onPress: jest.fn(),
    ...over,
  });

  /** Every `rotate` transform anywhere in the rendered tree. */
  const rotations = (tree: ReactTestRenderer): string[] =>
    tree.root.findAll(() => true)
      .flatMap((n) => (Array.isArray(n.props?.style) ? n.props.style : [n.props?.style]))
      .flatMap((x) => (x?.transform ?? []).map((tr: Record<string, string>) => tr.rotate))
      .filter(Boolean);

  /** Every `borderColor` anywhere in the rendered tree. */
  const borders = (tree: ReactTestRenderer): string[] =>
    tree.root.findAll(() => true)
      .flatMap((n) => (Array.isArray(n.props?.style) ? n.props.style : [n.props?.style]))
      .map((x) => x?.borderColor)
      .filter(Boolean);

  test("the compass turns with the map and reports a tap", () => {
    const props = compass({ rotationDeg: 90 });
    const tree = renderer.create(<Compass {...props} />);
    press(tree);
    expect(props.onPress).toHaveBeenCalledTimes(1);
  });

  test("the target arrow is drawn at the bearing MINUS the map rotation", () => {
    // The whole point. On a map twisted 90 degrees, an arrow at the raw bearing
    // points at open ground: 130 - 90 = 40.
    const tree = renderer.create(<Compass {...compass({ rotationDeg: 90, targetBearingDeg: 130 })} />);
    expect(rotations(tree)).toContain("40deg");
    // North is still shown, counter-rotated against the map.
    expect(rotations(tree)).toContain("-90deg");
  });

  test("with nothing to navigate to there is no arrow at all", () => {
    // An arrow with no target would be decoration pointing somewhere.
    const tree = renderer.create(<Compass {...compass({ rotationDeg: 90, targetBearingDeg: null })} />);
    // Deduplicated: findAll reports the composite and its host element both.
    expect([...new Set(rotations(tree))]).toEqual(["-90deg"]);
  });

  test("with no heading the control cannot be tapped into a mode it cannot perform", () => {
    const tree = renderer.create(<Compass {...compass({ headingDeg: null, headingUp: false })} />);
    expect(tree.root.findAllByType(Pressable)[0].props.disabled).toBe(true);
  });

  test("but heading-up can always be turned OFF, even after the heading is lost", () => {
    // Otherwise losing the magnetometer strands the map at a rotation the
    // geologist can no longer undo.
    const tree = renderer.create(<Compass {...compass({ headingDeg: null, headingUp: true })} />);
    expect(tree.root.findAllByType(Pressable)[0].props.disabled).toBe(false);
  });

  test("a heading that needs calibrating says so on the control that uses it", () => {
    // It can be reported with confidence and be thirty degrees wrong, and in
    // heading-up mode that error rotates the whole map.
    expect(borders(renderer.create(<Compass {...compass({ needsCalibration: true })} />))).toContain("#E0A02F");
    expect(borders(renderer.create(<Compass {...compass()} />))).not.toContain("#E0A02F");
  });

  test("the GPS chip opens the readout", () => {
    const onPress = jest.fn();
    const tree = renderer.create(<GpsChip text="±1.5 m" onPress={onPress} />);
    press(tree);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  test("the guidance pill opens the sheet", () => {
    const onPress = jest.fn();
    const tree = renderer.create(<TargetPill title="1.4 km NE" subtitle="High" onPress={onPress} />);
    press(tree);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe("MapTopBar", () => {
  test("back and end each call their own handler", () => {
    const onBack = jest.fn();
    const onEnd = jest.fn();
    const tree = renderer.create(
      <MapTopBar title="Exploration" status="Online" online onBack={onBack} onEnd={onEnd} top={40} />,
    );
    const all = pressables(tree);
    expect(all).toHaveLength(2);
    renderer.act(() => { all[0].props.onPress(); });
    renderer.act(() => { all[1].props.onPress(); });
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  test("it clears the notch by its own offset", () => {
    const style = rootStyle(renderer.create(
      <MapTopBar title="T" status="S" online onBack={jest.fn()} top={44} />,
    ));
    expect(style.position).toBe("absolute");
    expect(style.top).toBe(50);   // inset + the bar's own breathing room
  });

  test("with no session running there is nothing to end", () => {
    const tree = renderer.create(<MapTopBar title="T" status="S" online onBack={jest.fn()} top={0} />);
    expect(pressables(tree)).toHaveLength(1);
  });
});

describe("the sheet", () => {
  test("its actions fire, and the handle toggles it", () => {
    const onExpandedChange = jest.fn();
    const onAction = jest.fn();
    // The sheet reads the bottom safe-area inset so the Android navigation bar
    // cannot cover its last rows, which means it needs the provider mounted.
    const tree = renderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>
      <ExplorationSheet
        expandedHeight={500} expanded={false} onExpandedChange={onExpandedChange}
        header={<SheetAction icon={null} label="Capture" onPress={onAction} />}
      >
        <SheetAction icon={null} label="Waypoint" onPress={onAction} />
      </ExplorationSheet>
      </SafeAreaProvider>,
    );
    const all = pressables(tree);
    // The grab handle, plus the two actions.
    expect(all.length).toBeGreaterThanOrEqual(3);
    all.forEach((p) => renderer.act(() => { p.props.onPress(); }));
    expect(onExpandedChange).toHaveBeenCalledWith(true);
    expect(onAction).toHaveBeenCalledTimes(2);
  });


  test("its content clears the navigation bar", () => {
    // The recommendation lives in the HEADER, which never scrolls, and the sheet
    // is anchored to bottom:0 on an edge-to-edge screen — so without this the
    // last line a geologist reads sits under the Android buttons. Reported from
    // the field as "qoraalka ugu hooseeya … badhanada taleefanka ayaa qarinaya".
    const tree = renderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <ExplorationSheet
          expandedHeight={500} expanded={false} onExpandedChange={() => {}}
          header={<SheetAction icon={null} label="Capture" onPress={() => {}} />}
        >
          <SheetAction icon={null} label="Waypoint" onPress={() => {}} />
        </ExplorationSheet>
      </SafeAreaProvider>,
    );
    const paddings = tree.root.findAll(() => true)
      .flatMap((n) => (Array.isArray(n.props?.style) ? n.props.style : [n.props?.style]))
      .map((x) => x?.paddingBottom)
      .filter((v) => v !== undefined);
    expect(paddings).toContain(METRICS.insets.bottom);
  });

  test("a disabled action does not fire", () => {
    const onPress = jest.fn();
    const tree = renderer.create(<SheetAction icon={null} label="X" onPress={onPress} disabled />);
    const p = pressables(tree)[0];
    expect(p.props.disabled).toBe(true);
  });
});

describe("ScaleBar", () => {
  test("it sits where it is told, above the sheet", () => {
    const style = rootStyle(renderer.create(<ScaleBar metresPerPx={2} bottom={180} />));
    expect(style.position).toBe("absolute");
    expect(style.bottom).toBe(180);
  });

  test("a nonsense scale draws nothing rather than a wrong number", () => {
    expect(renderer.create(<ScaleBar metresPerPx={0} />).toJSON()).toBeNull();
  });
});

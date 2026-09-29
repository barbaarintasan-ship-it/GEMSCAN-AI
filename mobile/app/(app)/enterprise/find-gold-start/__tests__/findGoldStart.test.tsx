// Phase 18 — first regression coverage for find-gold-start (Phase 17 guided
// commodity entry). Only the true I/O boundary is mocked: `lib/supabase`'s
// query response. `fetchFeaturedCommodities`/`fetchCommodityChoices`
// (lib/enterprise/missions.ts) run FOR REAL against that mocked response —
// this is the same geo.commodity_profile row shape production uses, not a
// second, hand-invented commodity model.
import React from "react";
import renderer, { act, type ReactTestRenderer } from "react-test-renderer";
import { Text, Pressable } from "react-native";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: { language: "en" } }),
}));

const mockPush = jest.fn();
let mockFocusCallback: (() => void) | null = null;
jest.mock("expo-router", () => ({
  router: { push: (...args: unknown[]) => mockPush(...args), back: jest.fn() },
  useLocalSearchParams: () => ({ missionId: "mission-1" }),
  useFocusEffect: (cb: () => void) => { mockFocusCallback = cb; },
}));

// Real commodity_profile rows — the SAME columns fetchCommodityChoices()
// actually selects, for the 4 codes FEATURED_COMMODITIES asks for.
const PROFILE_ROWS = [
  { code: "gold", name: "Gold", category: "metal", typical_host_rocks: ["quartz vein"], deposit_models: ["orogenic", "placer / alluvial"] },
  { code: "diamond", name: "Diamond", category: "gemstone", typical_host_rocks: ["kimberlite"], deposit_models: ["kimberlite pipe"] },
  { code: "silver", name: "Silver", category: "metal", typical_host_rocks: [], deposit_models: [] },
  { code: "copper", name: "Copper", category: "metal", typical_host_rocks: ["porphyry"], deposit_models: ["porphyry"] },
  { code: "chromium", name: "Chromium", category: "metal", typical_host_rocks: [], deposit_models: [] },
];

jest.mock("../../../../../lib/supabase", () => ({
  supabase: {
    schema: (_s: string) => ({
      from: (_t: string) => ({
        select: (_cols: string) => ({
          order: (_col: string) => Promise.resolve({ data: PROFILE_ROWS, error: null }),
        }),
      }),
    }),
  },
}));

import FindGoldStartScreen from "../[missionId]";

async function mountAndLoad(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = renderer.create(<FindGoldStartScreen />); });
  await act(async () => { mockFocusCallback?.(); });
  await act(async () => { await Promise.resolve(); });
  return tree;
}

function textsOf(tree: ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).map((n) => (Array.isArray(n.props.children) ? n.props.children.join("") : String(n.props.children)));
}

/** Finds the Text node with this exact label and walks up to its Pressable ancestor. */
function pressableFor(tree: ReactTestRenderer, label: string) {
  const textNode = tree.root.findAllByType(Text).find((n) => n.props.children === label);
  expect(textNode).toBeTruthy();
  let node = textNode!.parent;
  while (node && node.type !== Pressable) node = node.parent;
  expect(node).toBeTruthy();
  return node!;
}

beforeEach(() => { mockPush.mockClear(); mockFocusCallback = null; });

describe("find-gold-start", () => {
  test("renders the featured commodity list from the REAL geo.commodity_profile query, not a hardcoded list", async () => {
    const tree = await mountAndLoad();
    const texts = textsOf(tree);
    expect(texts).toEqual(expect.arrayContaining(["Gold", "Diamond", "Silver", "Copper"]));
    // chromium exists in the mocked table but isn't one of the 4 featured codes.
    expect(texts).not.toEqual(expect.arrayContaining(["Chromium"]));
    act(() => { tree.unmount(); });
  });

  test("selecting Gold forwards commodity=gold to find-gold, not just missionId", async () => {
    const tree = await mountAndLoad();
    act(() => { (pressableFor(tree, "Gold").props as any).onPress(); });
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush.mock.calls[0][0]).toBe("/(app)/enterprise/find-gold/mission-1?commodity=gold");
    act(() => { tree.unmount(); });
  });

  test("selecting Diamond forwards commodity=diamond — a DIFFERENT commodity reaches the URL, not always gold", async () => {
    const tree = await mountAndLoad();
    act(() => { (pressableFor(tree, "Diamond").props as any).onPress(); });
    expect(mockPush.mock.calls[0][0]).toBe("/(app)/enterprise/find-gold/mission-1?commodity=diamond");
    act(() => { tree.unmount(); });
  });
});

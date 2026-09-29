// Phase 18 — first regression coverage for find-gold's title-per-commodity
// (titleFor()) and the commodity-forwarding fix to find-gold-detail (was
// silently dropped before this session's Phase 18 predecessor work).
// fetchMissionAreas/fetchAreaReviewDetail are mocked here (not the true I/O
// boundary): this screen's own logic under test is title/navigation, not
// commodity-profile data — that's find-gold-detail's test file.
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
  useLocalSearchParams: () => mockParams,
  useFocusEffect: (cb: () => void) => { mockFocusCallback = cb; },
}));

const AREA = { area_id: "area-1", name: "Test Area" };
jest.mock("../../../../../lib/enterprise/missions", () => ({
  fetchMissionAreas: async () => [AREA],
  fetchAreaReviewDetail: async () => ({
    areaId: "area-1", name: "Test Area", reviewStatus: "pending",
    reviewedBy: null, reviewedAt: null, reviewNotes: null, reviewerRole: null,
    sourceTargetH3: null, sourceTargetScore: null, sourceCommodity: null,
    cells: [{ target_h3: "877a1c210ffffff", prospectivity_score: 0.62, integrated_score: null, evidence_sample_count: 0, reasons: [{ kind: "occurrence", commodity: "Gold", distanceM: 300 }], coverage: null, evidence: [] }],
  }),
}));

let mockParams: { missionId: string; commodity?: string } = { missionId: "mission-1", commodity: "gold" };

import FindGoldScreen from "../[missionId]";

async function mountAndLoad(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = renderer.create(<FindGoldScreen />); });
  await act(async () => { mockFocusCallback?.(); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return tree;
}

function textsOf(tree: ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).map((n) => (Array.isArray(n.props.children) ? n.props.children.join("") : String(n.props.children)));
}

beforeEach(() => { mockPush.mockClear(); mockFocusCallback = null; });

describe("find-gold — titleFor() per commodity", () => {
  test("commodity=gold renders 'Find Gold'", async () => {
    mockParams = { missionId: "mission-1", commodity: "gold" };
    const tree = await mountAndLoad();
    expect(textsOf(tree)).toContain("Find Gold");
    act(() => { tree.unmount(); });
  });

  test("commodity=diamond renders 'Find Diamond' — a DIFFERENT title, not stuck on Gold", async () => {
    mockParams = { missionId: "mission-1", commodity: "diamond" };
    const tree = await mountAndLoad();
    expect(textsOf(tree)).toContain("Find Diamond");
    expect(textsOf(tree)).not.toContain("Find Gold");
    act(() => { tree.unmount(); });
  });

  test("no commodity selected falls back to 'Find Gold'", async () => {
    mockParams = { missionId: "mission-1" };
    const tree = await mountAndLoad();
    expect(textsOf(tree)).toContain("Find Gold");
    act(() => { tree.unmount(); });
  });

  test("an unlisted commodity code falls back to a capitalized generic title", async () => {
    mockParams = { missionId: "mission-1", commodity: "tin" };
    const tree = await mountAndLoad();
    expect(textsOf(tree)).toContain("Find Tin");
    act(() => { tree.unmount(); });
  });
});

describe("find-gold — commodity forwarding to find-gold-detail", () => {
  test("tapping an area card forwards commodity=diamond to find-gold-detail (previously silently dropped)", async () => {
    mockParams = { missionId: "mission-1", commodity: "diamond" };
    const tree = await mountAndLoad();
    const areaText = tree.root.findAllByType(Text).find((n) => n.props.children === "Test Area");
    expect(areaText).toBeTruthy();
    let node = areaText!.parent;
    while (node && node.type !== Pressable) node = node.parent;
    expect(node).toBeTruthy();
    act(() => { (node!.props as any).onPress(); });
    expect(mockPush).toHaveBeenCalledWith(
      "/(app)/enterprise/find-gold-detail/area-1?missionId=mission-1&commodity=diamond",
    );
    act(() => { tree.unmount(); });
  });

  test("no commodity selected — the URL has no dangling commodity param", async () => {
    mockParams = { missionId: "mission-1" };
    const tree = await mountAndLoad();
    const areaText = tree.root.findAllByType(Text).find((n) => n.props.children === "Test Area");
    let node = areaText!.parent;
    while (node && node.type !== Pressable) node = node.parent;
    act(() => { (node!.props as any).onPress(); });
    expect(mockPush).toHaveBeenCalledWith("/(app)/enterprise/find-gold-detail/area-1?missionId=mission-1");
    act(() => { tree.unmount(); });
  });
});

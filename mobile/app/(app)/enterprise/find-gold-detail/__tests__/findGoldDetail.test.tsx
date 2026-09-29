// Phase 18 — first regression coverage for find-gold-detail's field
// checklist ("What to look for"). The true I/O boundary (`lib/supabase`) is
// mocked with realistic geo.commodity_profile rows (the exact content
// verified live on-device this session for gold and diamond); everything
// else — fetchCommodityFieldChecklist's real query/parse logic — runs
// UNMODIFIED via jest.requireActual, per the instruction not to duplicate
// commodity-profile behaviour inside the test itself. Only the review/
// suggestions/spectral data-fetchers (irrelevant to this screen's checklist
// logic) are stubbed.
import React from "react";
import renderer, { act, type ReactTestRenderer } from "react-test-renderer";
import { Text } from "react-native";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: { language: "en" } }),
}));

jest.mock("expo-router", () => ({
  router: { push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => mockParams,
  useFocusEffect: (cb: () => void) => { mockFocusCallback = cb; },
}));

// Real geo.commodity_profile content (verified live on-device this session)
// for two genuinely different commodities — proves the checklist isn't a
// single hardcoded card, and that different profiles produce different content.
const GOLD_ROW = {
  code: "gold", name: "Gold",
  exploration_indicators: ["quartz veins in shear zones", "sulphide veinlets", "gossan/iron staining", "visible gold"],
  alteration_styles: ["silicification", "sericitic", "carbonatization", "iron staining"],
  associated_minerals: ["pyrite", "arsenopyrite", "quartz", "chalcopyrite", "galena", "tellurides"],
  confidence_limitations: "Quartz veins and iron staining are encouraging but not proof of gold.",
};
const DIAMOND_ROW = {
  code: "diamond", name: "Diamond",
  exploration_indicators: ["kimberlite pipe/dyke", "mantle indicator minerals", "pyrope garnet", "chrome diopside"],
  alteration_styles: ["serpentinization"],
  associated_minerals: ["pyrope garnet", "chrome diopside", "chromite", "ilmenite", "olivine"],
  confidence_limitations: "Not every kimberlite is diamond-bearing.",
};
const mockRowsByCode: Record<string, typeof GOLD_ROW> = { gold: GOLD_ROW, diamond: DIAMOND_ROW };

jest.mock("../../../../../lib/supabase", () => ({
  supabase: {
    schema: (_s: string) => ({
      from: (_t: string) => ({
        select: (_cols: string) => ({
          eq: (_col: string, code: string) => ({
            maybeSingle: () => Promise.resolve({ data: mockRowsByCode[code] ?? null, error: null }),
          }),
        }),
      }),
    }),
  },
}));

const AREA_DETAIL = {
  areaId: "area-1", name: "Test Area", reviewStatus: "pending",
  reviewedBy: null, reviewedAt: null, reviewNotes: null, reviewerRole: null,
  sourceTargetH3: null, sourceTargetScore: null, sourceCommodity: null,
  cells: [{ target_h3: "877a1c210ffffff", prospectivity_score: 0.62, integrated_score: null, evidence_sample_count: 0, reasons: [{ kind: "occurrence", commodity: "Gold", distanceM: 300 }], coverage: null, evidence: [] }],
};

jest.mock("../../../../../lib/enterprise/missions", () => {
  const actual = jest.requireActual("../../../../../lib/enterprise/missions");
  return {
    ...actual, // fetchCommodityFieldChecklist stays REAL
    fetchAreaReviewDetail: async () => AREA_DETAIL,
    isMissionManager: async () => false,
    fetchAreaFieldSuggestions: async () => [],
  };
});

let mockParams: { areaId: string; missionId: string; commodity?: string } = { areaId: "area-1", missionId: "mission-1", commodity: "gold" };
let mockFocusCallback: (() => void) | null = null;

import FindGoldDetailScreen from "../[areaId]";

async function mountAndLoad(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = renderer.create(<FindGoldDetailScreen />); });
  await act(async () => { mockFocusCallback?.(); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  return tree;
}

function textsOf(tree: ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).map((n) => (Array.isArray(n.props.children) ? n.props.children.join("") : String(n.props.children)));
}

beforeEach(() => { mockFocusCallback = null; });

describe("find-gold-detail — field checklist ('What to look for')", () => {
  test("with commodity=gold, shows the REAL gold checklist content", async () => {
    mockParams = { areaId: "area-1", missionId: "mission-1", commodity: "gold" };
    const tree = await mountAndLoad();
    const texts = textsOf(tree);
    expect(texts.some((t) => t.includes("What to look for: Gold"))).toBe(true);
    expect(texts).toEqual(expect.arrayContaining([
      "• quartz veins in shear zones", "• sulphide veinlets", "• gossan/iron staining", "• visible gold",
      "• silicification", "• pyrite", "• arsenopyrite",
    ]));
    // Diamond-only content must not leak in.
    expect(texts.some((t) => t.includes("kimberlite"))).toBe(false);
    act(() => { tree.unmount(); });
  });

  test("with commodity=diamond, shows DIFFERENT real checklist content — not the gold card again", async () => {
    mockParams = { areaId: "area-1", missionId: "mission-1", commodity: "diamond" };
    const tree = await mountAndLoad();
    const texts = textsOf(tree);
    expect(texts.some((t) => t.includes("What to look for: Diamond"))).toBe(true);
    expect(texts).toEqual(expect.arrayContaining([
      "• kimberlite pipe/dyke", "• mantle indicator minerals", "• pyrope garnet", "• chrome diopside",
      "• serpentinization", "• chromite", "• ilmenite", "• olivine",
    ]));
    // Gold-only content must not leak in.
    expect(texts.some((t) => t.includes("gossan"))).toBe(false);
    act(() => { tree.unmount(); });
  });

  test("with no commodity selected, the checklist card does not render at all", async () => {
    mockParams = { areaId: "area-1", missionId: "mission-1" };
    const tree = await mountAndLoad();
    const texts = textsOf(tree);
    expect(texts.some((t) => t.includes("What to look for"))).toBe(false);
    act(() => { tree.unmount(); });
  });

  test("an unknown/unprofiled commodity code renders no checklist card, not an error", async () => {
    mockParams = { areaId: "area-1", missionId: "mission-1", commodity: "unobtainium" };
    const tree = await mountAndLoad();
    const texts = textsOf(tree);
    expect(texts.some((t) => t.includes("What to look for"))).toBe(false);
    act(() => { tree.unmount(); });
  });
});

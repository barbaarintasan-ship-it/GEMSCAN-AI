// Gold Prospect Evaluation — a Gem Collector-only, ADDITIVE feature.
//
// It performs a RULE-BASED geological prospect interpretation using data the
// app ALREADY has (the identified host rock + its confidence, from the existing
// scan result) plus optional user field answers. It makes NO AI / model calls,
// adds NO new database tables or APIs, and NEVER confirms that gold exists — it
// only produces an exploration score (0–100) and guidance. All logic here is a
// pure, deterministic function of its inputs (see goldProspect.test.ts).

export type FoundContext = "river" | "mountain" | "old_mine" | "quartz_vein" | "loose_surface" | "unknown";
export type NearbyDensity = "many" | "few" | "one" | "unknown";
export type Observation = "quartz_veins" | "rust_staining" | "black_sulfides" | "metallic_particles" | "heavy_minerals";

export type GoldProspectAnswers = {
  country?: string;
  region?: string;
  district?: string;
  foundContext: FoundContext;
  nearbyDensity: NearbyDensity;
  observations: Observation[];
};

export const EMPTY_ANSWERS: GoldProspectAnswers = {
  foundContext: "unknown",
  nearbyDensity: "unknown",
  observations: [],
};

export type ProspectCategory = "very_low" | "low" | "moderate" | "high" | "very_high";
export type EconomicPotential = "none" | "low" | "moderate" | "promising" | "highly_promising";

export type GoldProspectReport = {
  hostRock: string;
  hostConfidencePct: number;
  environment: string;
  score: number; // 0-100
  category: ProspectCategory;
  economic: EconomicPotential;
  evidenceFor: string[];
  evidenceAgainst: string[];
  nextSteps: string[];
};

type Translate = (en: string, so: string) => string;

// Host rocks / minerals commonly associated with gold, strongest first. `base`
// is the starting exploration-score contribution; `env` is the geological
// setting shown to the user.
const GOLD_HOSTS: { keys: string[]; base: number; envEn: string; envSo: string }[] = [
  {
    keys: ["gold-bearing quartz", "gold bearing quartz", "auriferous", "visible gold"],
    base: 58,
    envEn: "Hydrothermal quartz — the classic lode (vein) gold host.",
    envSo: "Quartz hydrothermal ah — deegaanka caadiga ah ee dahabka xididka (vein).",
  },
  { keys: ["arsenopyrite"], base: 48, envEn: "Arsenopyrite — a sulfide strongly linked to orogenic gold.", envSo: "Arsenopyrite — sulfide si xoog leh ugu xiran dahabka orogenic." },
  { keys: ["greenstone"], base: 44, envEn: "Greenstone belt — hosts many of the world's major gold deposits.", envSo: "Greenstone belt — martida u ah kayd dahab oo waaweyn oo adduunka." },
  { keys: ["quartz vein", "quartz-vein"], base: 42, envEn: "Hydrothermal quartz vein — a common lode-gold structure.", envSo: "Xidid quartz hydrothermal ah — qaab-dhismeed dahab oo caadi ah." },
  { keys: ["pyrite"], base: 40, envEn: "Pyrite ('fool's gold') — a sulfide that often accompanies gold.", envSo: "Pyrite ('dahabka nacasnimada') — sulfide badanaa dahabka la socda." },
  { keys: ["gossan"], base: 36, envEn: "Gossan — an oxidized cap over sulfides; a gold pathfinder.", envSo: "Gossan — dahaar oksaydh ah oo sulfide dul saaran; tilmaame dahab." },
  { keys: ["quartz schist", "schist"], base: 34, envEn: "Quartz schist — a metamorphic host that can carry gold.", envSo: "Quartz schist — deegaan metamorphic oo dahab qaadi kara." },
  { keys: ["ironstone", "banded iron"], base: 32, envEn: "Ironstone / BIF — can cap or be associated with mineralized zones.", envSo: "Ironstone / BIF — waxay dul saari kartaa aagag macdan leh." },
  { keys: ["quartzite", "quartz"], base: 24, envEn: "Quartz — a weak, non-specific association with gold.", envSo: "Quartz — xiriir daciif ah oo aan gaar ahayn dahabka." },
];

export function detectGoldHost(labels: string[]): { label: string; base: number; envEn: string; envSo: string } | null {
  const hay = labels.filter(Boolean).map((l) => l.toLowerCase());
  for (const host of GOLD_HOSTS) {
    const key = host.keys.find((k) => hay.some((h) => h.includes(k)));
    if (key) {
      const matched = labels.find((l) => l.toLowerCase().includes(key)) ?? labels[0] ?? key;
      return { label: matched, base: host.base, envEn: host.envEn, envSo: host.envSo };
    }
  }
  return null;
}

export function isGoldProspectHost(labels: string[]): boolean {
  return detectGoldHost(labels) !== null;
}

export function categoryOf(score: number): ProspectCategory {
  if (score <= 20) return "very_low";
  if (score <= 40) return "low";
  if (score <= 60) return "moderate";
  if (score <= 80) return "high";
  return "very_high";
}

export function economicOf(score: number): EconomicPotential {
  if (score < 20) return "none";
  if (score < 40) return "low";
  if (score < 60) return "moderate";
  if (score < 80) return "promising";
  return "highly_promising";
}

const uniq = (arr: string[]): string[] => Array.from(new Set(arr));

export function evaluateGoldProspect(
  input: { labels: string[]; confidencePct: number; answers: GoldProspectAnswers },
  L: Translate,
): GoldProspectReport | null {
  const host = detectGoldHost(input.labels);
  if (!host) return null;

  const a = input.answers;
  const has = (o: Observation) => a.observations.includes(o);
  const forE: string[] = [];
  const againstE: string[] = [];
  const steps: string[] = [];
  let score = host.base;

  forE.push(L(`Host rock "${host.label}" is commonly associated with gold mineralization.`, `Dhagaxa martida "${host.label}" badanaa waxaa lala xiriiriyaa macdanaynta dahabka.`));

  if (has("metallic_particles")) { score += 15; forE.push(L("Visible metallic particles were reported.", "Waxaa la sheegay walxo bir ah oo la arki karo.")); }
  if (has("black_sulfides")) { score += 10; forE.push(L("Black sulfide minerals reported (possible pyrite / arsenopyrite).", "Waxaa la sheegay macdano sulfide madow (malaha pyrite / arsenopyrite).")); }
  else againstE.push(L("No sulfide minerals were observed.", "Macdano sulfide ah lama arag."));
  if (has("quartz_veins")) { score += 8; forE.push(L("Quartz veins were observed.", "Xididada quartz waa la arkay.")); }
  else againstE.push(L("No quartz veins were observed.", "Xidid quartz ah lama arag."));
  if (has("rust_staining")) { score += 8; forE.push(L("Iron-oxide (rust) staining observed — possibly oxidized sulfides.", "Wasakh oksaydh-bir (miri) ah — malaha sulfide oksaydhoobay.")); }
  if (has("heavy_minerals")) { score += 8; forE.push(L("Heavy minerals were reported.", "Waxaa la sheegay macdano culus.")); }

  switch (a.foundContext) {
    case "old_mine": score += 10; forE.push(L("Found at an old mine — a known mineralized area.", "Laga helay macdan-qodid hore — aag macdan leh oo la yaqaan.")); steps.push(L("Research the mine's historical production records.", "Baadh diiwaanka wax-soo-saarkii hore ee macdanta.")); break;
    case "quartz_vein": score += 8; forE.push(L("Found in or near a quartz-vein structure.", "Laga helay xidid quartz ama meel u dhow.")); steps.push(L("Trace and sample the quartz vein along strike.", "Raac oo muunad ka qaad xididka quartz.")); break;
    case "river": score += 6; forE.push(L("Found in a river — alluvial (placer) transport is possible.", "Laga helay webi — gaadiid alluvial (placer) suurtogal ah.")); steps.push(L("Pan the river sediments and gravels nearby.", "Panning ku samee dhoobada iyo quruurux webiga.")); break;
    case "mountain": score += 3; break;
    case "loose_surface": score += 2; againstE.push(L("Loose surface float — not in place; the in-situ source is unknown.", "Dhagax dul-yaal oo aan meesheeda ahayn — isha dhabta ah lama garanayo.")); break;
    default: break;
  }

  switch (a.nearbyDensity) {
    case "many": score += 6; forE.push(L("Many similar rocks nearby — a possible in-situ source.", "Dhagxaan badan oo la mid ah oo u dhow — isha suurtogal ah.")); break;
    case "few": score += 3; break;
    case "one": againstE.push(L("Only a single specimen — an isolated float.", "Hal xabbo oo keliya — dhagax go'doonsan.")); break;
    default: break;
  }

  if (input.confidencePct < 55) { score -= 5; againstE.push(L("Identification confidence is limited (image quality or ambiguity).", "Kalsoonida aqoonsiga waa xaddidan (tayada sawirka ama madmadow).")); }

  const answered = a.observations.length + (a.foundContext !== "unknown" ? 1 : 0) + (a.nearbyDensity !== "unknown" ? 1 : 0);
  if (answered === 0) againstE.push(L("Limited field information — this score is based on the host rock alone.", "Macluumaad goob oo xaddidan — dhibcahani waxay ku salaysan yihiin dhagaxa martida oo keliya."));

  score = Math.max(0, Math.min(100, Math.round(score)));

  // Recommended next steps (relevant, de-duplicated).
  steps.push(L("Collect additional representative samples from the site.", "Ka ururi muunado dheeraad ah oo goobta matalaya."));
  if (has("quartz_veins") || a.foundContext === "quartz_vein") steps.push(L("Inspect and sample the surrounding quartz veins.", "Baadh oo muunad ka qaad xididada quartz ee ku wareegsan."));
  steps.push(L("Sweep the area with a metal detector.", "Meesha ku baadh metal detector."));
  if (a.foundContext === "river") steps.push(L("Perform panning in the river.", "Panning ku samee webiga."));
  if (score >= 40) { steps.push(L("Send samples for XRF analysis.", "U dir muunadaha falanqaynta XRF.")); steps.push(L("Consider a Fire Assay to measure gold grade.", "Tixgeli Fire Assay si loo cabbiro heerka dahabka.")); }
  steps.push(L("Have promising samples tested at a professional laboratory.", "Muunadaha rajada leh ku baadh shaybaar xirfad leh."));

  return {
    hostRock: host.label,
    hostConfidencePct: input.confidencePct,
    environment: L(host.envEn, host.envSo),
    score,
    category: categoryOf(score),
    economic: economicOf(score),
    evidenceFor: uniq(forE),
    evidenceAgainst: uniq(againstE),
    nextSteps: uniq(steps),
  };
}

export function categoryLabel(c: ProspectCategory, so: boolean): string {
  const m: Record<ProspectCategory, [string, string]> = {
    very_low: ["Very Low", "Aad u hooseeya"],
    low: ["Low", "Hooseeya"],
    moderate: ["Moderate", "Dhexdhexaad"],
    high: ["High", "Sare"],
    very_high: ["Very High", "Aad u sarreeya"],
  };
  return so ? m[c][1] : m[c][0];
}

export function economicLabel(e: EconomicPotential, so: boolean): string {
  const m: Record<EconomicPotential, [string, string]> = {
    none: ["No indication", "Tilmaan ma leh"],
    low: ["Low exploration interest", "Xiise sahamineed oo hooseeya"],
    moderate: ["Moderate exploration interest", "Xiise sahamineed oo dhexdhexaad"],
    promising: ["Promising exploration target", "Bartilmaameed sahamineed oo rajo leh"],
    highly_promising: ["Highly promising target", "Bartilmaameed aad u rajo leh"],
  };
  return so ? m[e][1] : m[e][0];
}

export function categoryColor(c: ProspectCategory): string {
  switch (c) {
    case "very_low": return "#8A8A8E";
    case "low": return "#B9902B";
    case "moderate": return "#C9A227";
    case "high": return "#2E9E4F";
    case "very_high": return "#2E7D32";
  }
}

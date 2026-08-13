// What changes when you say WHICH mineral you are looking for.
//
// The engine has been answering one question — "is this ground prospective?" —
// with one number, for every commodity at once. That is not a geological
// statement. Placer gold is a drainage question; orogenic gold is a structural
// one; REE in carbonatite is a lithological one; nickel laterite wants the flat
// weathered surface that every other model treats as barren cover. A single
// formula cannot be right for all of them, and the pack has carried 23 commodity
// profiles that could say so since before any of this was written.
//
// WHAT THIS IS NOT, AND THE HONESTY THAT COSTS
// --------------------------------------------
// It is NOT a calibrated model, and it cannot be. The label set makes that
// arithmetic rather than opinion:
//
//     iron        37 occurrences   the only commodity with enough for a weak fit
//     manganese    8
//     beryllium    7
//     tin          3
//     copper       1
//     GOLD         0               not one, in the whole pack
//     (null)      55               no commodity recorded at all
//
// and 143 of 159 occurrences carry no deposit_type. So there is nothing to fit a
// gold model on, nothing to test a placer hypothesis with, and no basis for a
// number like "62% chance of gold". Every rule here is read from the profile's own
// geological content and is labelled `expert_rule` or `uncalibrated`. Nothing is
// labelled `measured` unless it came from the fitted priors.
//
// TWO MODES, KEPT APART
// ---------------------
// With no commodity chosen the engine behaves EXACTLY as the validated universal
// model does — same evidence, same weights, byte for byte — because that is the
// path the leakage and usefulness gates measure. Choosing a commodity switches on
// conditioning that those gates cannot measure, and the result says so.
import type { EvidenceRole } from "./evidenceRoles";
import type { PackCommodityProfile, PackData } from "../../../shared/geo-core/pack/types";

/**
 * How much a statement is worth knowing, in the sense the reader needs.
 *
 *   measured     fitted from this pack's own data — the lithology and landform
 *                priors, and the occurrence proximity terms.
 *   expert_rule  read from the commodity profile's geological content. Placer
 *                deposit models make drainage relevant because that is what a
 *                placer IS, not because a correlation was observed.
 *   uncalibrated a weight with a defensible shape and no number behind it. Used
 *                where a role must enter the score for a deposit style and there
 *                is no data to size it with.
 *   unsupported  the profile does not say, so nothing is claimed.
 */
export type EvidenceBasis = "measured" | "expert_rule" | "uncalibrated" | "unsupported";

export interface RoleRelevance {
  /** Multiplies the role's base weight. 1.0 is "no opinion". */
  factor: number;
  basis: EvidenceBasis;
  /** Traceable to the profile field that produced it. */
  why: string;
}

export interface CommodityCalibration {
  /** Occurrences of this commodity in the pack — the whole training set. */
  occurrences: number;
  calibrated: boolean;
  reason: string;
}

export interface CommodityModel {
  code: string;
  name: string;
  depositModels: readonly string[];
  /** Deposit-model families the profile matches. Drives most of the rules. */
  families: readonly DepositFamily[];
  /** Mapped rock classes this commodity's host rocks are compatible with. */
  compatibleRockClasses: ReadonlySet<string>;
  /** Field observation types the profile's indicators single out. */
  diagnosticObservations: ReadonlySet<string>;
  relevance: ReadonlyMap<EvidenceRole, RoleRelevance>;
  calibration: CommodityCalibration;
  /** The profile's own statement of what it cannot tell you. */
  limitations: string;
}

export type DepositFamily =
  | "placer" | "structural" | "intrusive" | "sedimentary" | "lateritic" | "metamorphic";

/**
 * Conditioning may adjust, never dominate.
 *
 * Bounded either side of 1.0 so a rule with no calibration behind it cannot turn
 * a weak measured signal into a strong one, or bury a strong one.
 */
export const MIN_FACTOR = 0.5;
export const MAX_FACTOR = 1.5;

/**
 * The weight drainage carries for a placer commodity.
 *
 * UNCALIBRATED, and deliberately the smallest weight in the engine — below the
 * measured landform cap of 0.22 and the measured lithology cap of 0.30. There is
 * no number to fit it to: the pack contains zero occurrences described as placer
 * or alluvial. What justifies it existing at all is that a placer IS a channel
 * deposit, so an engine asked about placer gold that ignores where the water runs
 * is answering a different question. What justifies it being small is that
 * nothing has measured it.
 */
export const DRAINAGE_PLACER_WEIGHT = 0.15;

/** Beyond this a channel is not the placer environment any more. */
export const DRAINAGE_PLACER_REACH_M = 1_500;

// ── Reading the profile ─────────────────────────────────────────────────────

const FAMILY_PATTERNS: Array<{ family: DepositFamily; re: RegExp }> = [
  { family: "placer", re: /placer|alluvial|detrital/i },
  { family: "structural", re: /orogenic|vein|shear|greisen|epithermal|IOCG/i },
  { family: "intrusive", re: /porphyry|pegmatite|carbonatite|granite|intrusion|magmatic|kimberlite|lamproite|skarn|reef/i },
  { family: "sedimentary", re: /sandstone|shale|sediment-hosted|sedimentary|BIF|banded iron|evaporite|brine|clay|unconformity/i },
  { family: "lateritic", re: /laterite|supergene|ion-adsorption/i },
  { family: "metamorphic", re: /metamorphic|schist|marble|gneiss|graphite in metamorphic/i },
];

export function depositFamilies(models: readonly string[] | null): DepositFamily[] {
  const out = new Set<DepositFamily>();
  for (const m of models ?? []) {
    for (const { family, re } of FAMILY_PATTERNS) if (re.test(m)) out.add(family);
  }
  return [...out];
}

/**
 * Which of the map's eight rock classes a named lithology could belong to.
 *
 * The mapped geology is 8 broad classes — metamorphic, volcanic, sedimentary,
 * plutonic and a few compounds — while the profiles name specific lithologies:
 * pegmatite, carbonatite, banded iron formation, greywacke. "Pegmatite" cannot be
 * resolved to "plutonic" with certainty, so this is COMPATIBILITY, not identity:
 * a pegmatite would be mapped as plutonic if it were mapped at all.
 *
 * Deliberately generous. Its job is to damp a commodity in ground that clearly
 * cannot host it — lithium pegmatite in Cenozoic cover — not to award points for
 * a match the map is too coarse to confirm.
 */
const HOST_ROCK_CLASSES: Array<{ re: RegExp; classes: string[] }> = [
  { re: /pegmatite|granite|felsic intrusive|porphyry|gabbro|dunite|pyroxenite|layered mafic|carbonatite|alkaline intrusion|kimberlite|lamproite|ultramafic|komatiite|magmatic|greisen|chromitite|titaniferous magnetite/i,
    classes: ["plutonic", "plutonic and metamorphic"] },
  { re: /gneiss|schist|paragneiss|marble|serpentinite|skarn|shear zone|quartz vein|hydrothermal vein|banded iron formation/i,
    classes: ["metamorphic", "plutonic and metamorphic"] },
  { re: /sandstone|shale|claystone|carbonate|chert|evaporite|greywacke|laterite|placer|sediment-hosted|sedimentary/i,
    classes: ["sedimentary", "sedimentary and volcaniclastic"] },
  { re: /basalt|rhyolite|felsic volcanic|VMS/i,
    classes: ["volcanic", "volcanic-sedimentary", "sedimentary and volcaniclastic"] },
];

export function compatibleRockClasses(hostRocks: readonly string[] | null): Set<string> {
  const out = new Set<string>();
  for (const h of hostRocks ?? []) {
    for (const { re, classes } of HOST_ROCK_CLASSES) if (re.test(h)) for (const c of classes) out.add(c);
  }
  return out;
}

/**
 * Field observation types this commodity's own indicators single out.
 *
 * The geologist already records `gossan`, `sulfides`, `quartz-vein`, `alteration`
 * and the rest. Which of them MEAN something depends entirely on what is being
 * looked for, and the profile says: gold lists "quartz veins in shear zones",
 * "sulphide veinlets", "gossan/iron staining".
 */
export function diagnosticObservations(p: PackCommodityProfile): Set<string> {
  const text = [
    ...(p.exploration_indicators ?? []),
    ...(p.alteration_styles ?? []),
    ...(p.associated_minerals ?? []),
  ].join(" ").toLowerCase();

  const out = new Set<string>();
  if (/gossan|iron stain|hematit|limonit/.test(text)) out.add("gossan");
  if (/sulphide|sulfide|pyrite|arsenopyrite|chalcopyrite|galena|sphalerite/.test(text)) out.add("sulfides");
  if (/quartz vein|quartz-vein/.test(text)) out.add("quartz-vein");
  if (/vein/.test(text)) out.add("vein");
  if ((p.alteration_styles ?? []).length > 0) out.add("alteration");
  return out;
}

// ── The rules ───────────────────────────────────────────────────────────────

const clampFactor = (f: number) => Math.max(MIN_FACTOR, Math.min(MAX_FACTOR, f));

/**
 * Turn a profile into per-role relevance.
 *
 * Every entry carries the field it was read from. A role the profile says nothing
 * about gets no entry at all, which the caller treats as factor 1.0 — no opinion,
 * rather than a quiet default dressed as a decision.
 */
function relevanceFor(p: PackCommodityProfile, families: DepositFamily[]): Map<EvidenceRole, RoleRelevance> {
  const r = new Map<EvidenceRole, RoleRelevance>();
  const has = (f: DepositFamily) => families.includes(f);

  // DRAINAGE. The one role that is off by default and can only be switched on
  // here — and only for the deposit style that is defined by channels.
  if (has("placer")) {
    r.set("drainage", {
      factor: 1,
      basis: "uncalibrated",
      why: `deposit_models include a placer style (${p.deposit_models?.filter((m) => /placer|alluvial|detrital/i.test(m)).join(", ")}); ` +
        `a placer is a channel deposit. No occurrence in this pack is described as placer, so the weight is not fitted.`,
    });
  }

  // STRUCTURE. Orogenic, vein, shear and greisen systems are structurally
  // controlled; that is what those model names mean.
  if (has("structural")) {
    r.set("structural", {
      factor: clampFactor(1.3),
      basis: "expert_rule",
      why: `deposit_models are structurally controlled (${p.deposit_models?.filter((m) => /orogenic|vein|shear|greisen|epithermal|IOCG/i.test(m)).join(", ")})`,
    });
  }

  // TERRAIN. Two opposite readings, and the profile decides which.
  if (has("lateritic")) {
    // Laterite and supergene enrichment form on stable, flat, deeply weathered
    // surfaces — the landform the universal prior treats as least prospective.
    r.set("terrain", {
      factor: clampFactor(1.2),
      basis: "expert_rule",
      why: `deposit_models are weathering-hosted (${p.deposit_models?.filter((m) => /laterite|supergene|ion-adsorption/i.test(m)).join(", ")}); ` +
        `these form on flat, stable, deeply weathered surfaces, which the universal landform prior scores lowest`,
    });
  } else if (has("placer")) {
    r.set("terrain", {
      factor: clampFactor(1.2),
      basis: "expert_rule",
      why: "placer systems sit in valley floors, which the landform prior already favours",
    });
  }

  // LITHOLOGY. Handled at scoring time against the class actually underfoot,
  // because compatibility is a property of the pair, not of the commodity.
  if ((p.typical_host_rocks ?? []).length > 0) {
    r.set("geology", {
      factor: 1,
      basis: "expert_rule",
      why: `typical_host_rocks: ${(p.typical_host_rocks ?? []).join(", ")}`,
    });
  }

  // FIELD OBSERVATIONS. Also pair-dependent — which TYPE was recorded matters —
  // so the entry records that the profile has something to say.
  const diag = diagnosticObservations(p);
  if (diag.size > 0) {
    r.set("field", {
      factor: 1,
      basis: "expert_rule",
      why: `exploration_indicators and alteration_styles single out: ${[...diag].join(", ")}`,
    });
  }

  return r;
}

/**
 * How many occurrences of this commodity the pack holds, and whether that is
 * enough to fit anything.
 *
 * Twenty is not a real statistical threshold; it is the point below which nobody
 * should pretend. Only iron reaches it, at 37.
 */
const MIN_FOR_CALIBRATION = 20;

function calibrationFor(code: string, pack: PackData): CommodityCalibration {
  const key = code.toLowerCase();
  const n = (pack.occurrences ?? []).filter((o) => (o.commodity_key ?? "").toLowerCase() === key).length;
  if (n >= MIN_FOR_CALIBRATION) {
    return {
      occurrences: n,
      calibrated: false,
      reason: `${n} occurrences — enough to attempt a fit, and none has been done yet. ` +
        `Until one is, the rules here are geological, not statistical.`,
    };
  }
  return {
    occurrences: n,
    calibrated: false,
    reason: n === 0
      ? `no occurrence of this commodity exists in the pack, so nothing can be fitted or tested`
      : `${n} occurrence${n === 1 ? "" : "s"} in the pack — far below the ${MIN_FOR_CALIBRATION} ` +
        `a fit would need, so the rules here are geological, not statistical`,
  };
}

/**
 * Resolve a commodity code into a conditioned model, or null if the pack has no
 * profile for it.
 *
 * Null is a real answer: chromium ships with every profile field empty, and a
 * model built from nothing would be a model built from nothing.
 */
export function buildCommodityModel(pack: PackData, code: string): CommodityModel | null {
  const p = (pack.commodities ?? []).find((c) => c.code.toLowerCase() === code.toLowerCase());
  if (!p) return null;

  const populated =
    (p.typical_host_rocks?.length ?? 0) + (p.deposit_models?.length ?? 0) +
    (p.exploration_indicators?.length ?? 0) + (p.alteration_styles?.length ?? 0);
  if (populated === 0) return null;   // chromium: a profile row with no content

  const families = depositFamilies(p.deposit_models);
  return {
    code: p.code,
    name: p.name,
    depositModels: p.deposit_models ?? [],
    families,
    compatibleRockClasses: compatibleRockClasses(p.typical_host_rocks),
    diagnosticObservations: diagnosticObservations(p),
    relevance: relevanceFor(p, families),
    calibration: calibrationFor(p.code, pack),
    limitations: p.confidence_limitations ?? "",
  };
}

const cache = new WeakMap<PackData, Map<string, CommodityModel | null>>();

export function commodityModelFor(pack: PackData, code: string | null | undefined): CommodityModel | null {
  if (!code) return null;
  let byCode = cache.get(pack);
  if (!byCode) { byCode = new Map(); cache.set(pack, byCode); }
  const key = code.toLowerCase();
  if (!byCode.has(key)) byCode.set(key, buildCommodityModel(pack, code));
  return byCode.get(key) ?? null;
}

/** The factor for a role, and 1.0 with no opinion when the profile is silent. */
export function factorFor(model: CommodityModel | null, role: EvidenceRole): number {
  if (!model) return 1;
  return model.relevance.get(role)?.factor ?? 1;
}

/** Whether this commodity's own profile makes a role relevant at all. */
export function isRelevant(model: CommodityModel | null, role: EvidenceRole): boolean {
  return model != null && model.relevance.has(role);
}

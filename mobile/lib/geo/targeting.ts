// TargetingEngine — workflow step 3, "where should I go, and why?" (Stage E4).
//
// GeoContext answers what is HERE. This answers where to go NEXT: it scores the
// neighbouring H3 cells and ranks them, deterministically and offline, using the
// same evidence and the same confidence model as everything else.
//
// Contract (Architecture §10.5): given a position, rank the k-ring by
// prospectivity and return { cell, bearing, distanceM, score, reason }.
//
// Two rules constrain the whole design:
//   Invariant 2 — no unexplained recommendation. Every target carries the
//     evidence statements that produced it, because a user with no geological
//     training is being asked to walk somewhere.
//   Invariant 4 — no fabricated geology. A cell with no evidence scores zero
//     and is not recommended. "I don't know here" is a valid output.
import { bearingDeg, compassPoint, haversineM } from "../../../shared/geo-core/geo/spatial.ts";
import { bandFor, computeConfidence } from "../../../shared/geo-core/confidence.ts";
import type { ConfidenceBand, EvidenceItem, GeoContext } from "../../../shared/geo-core/types.ts";
import { cellCentre, cellFor, kRing } from "./h3.ts";
import {
  DEFAULT_CONTEXT_RADIUS_M, type GeoContextQuery, type OfflineGeoContextService,
} from "./offlineGeoContext.ts";
import { markPhase } from "../diagnostics/jsStall";
import type { LocalEvidenceSource } from "../exploration/localEvidence.ts";
import { featuresNear, intersectionsOf } from "./terrainProviders.ts";
import type { PackData } from "../../../shared/geo-core/pack/types.ts";
import { ROLES_NOT_SCORED, type EvidenceRole } from "./evidenceRoles";
import { coverageAt, type EvidenceCoverage } from "./evidenceCoverage";
import { lithologyPriorFor, type LithologyPrior } from "./lithologyPrior";
import { terrainPriorFor, TERRAIN_MATCH_M, type TerrainPrior } from "./terrainPrior";
import { terrainIndexFor } from "./terrainIndex";
import { unitAt } from "./featureInfo";
import { featuresNear as linesNear } from "./terrainProviders";
import {
  commodityModelFor, factorFor, isRelevant,
  DRAINAGE_PLACER_REACH_M, DRAINAGE_PLACER_WEIGHT, type CommodityModel,
} from "./commodityModel";

/**
 * A reason, structured rather than pre-formatted.
 *
 * The app is bilingual and a Somali geologist who reads no English must be able
 * to use it. A reason built as an English sentence here cannot be translated at
 * the edge, so the engine emits WHAT it found and the UI renders it in the
 * user's language.
 */
export type TargetReason =
  | { kind: "occurrence"; commodity: string; distanceM: number }
  | { kind: "association"; commodity: string }
  | { kind: "community"; count: number }
  | { kind: "observation"; label: string; distanceM: number }
  | { kind: "fault"; distanceM: number }
  | { kind: "contact"; distanceM: number }
  | { kind: "intersection"; distanceM: number }
  | { kind: "unit"; name: string };

export interface ExplorationTarget {
  cell: string;
  centre: { lat: number; lng: number };
  /** Degrees clockwise from true north — what the heading arrow points along. */
  bearingDeg: number;
  /** Spoken form of the bearing, e.g. "NE". */
  compass: string;
  distanceM: number;
  /** 0..1, computed from evidence — never asserted (GIE Principle #4). */
  score: number;
  band: ConfidenceBand;
  /** Why this target. Structured so the UI can render it in either language. */
  reasons: TargetReason[];
  /** Commodities the evidence at that cell points at. */
  commodities: string[];
  /**
   * What this score was built from, and what it could not be built from.
   *
   * A 0.6 from one fault and a 0.6 from six agreeing layers are not the same
   * claim, and until now the app showed them identically.
   */
  coverage: EvidenceCoverage;
  /**
   * The commodity this ranking was computed under, or null for the universal engine.
   *
   * Recorded ON THE TARGET rather than read from the current selection, because the
   * two can differ: a target issued under UNIVERSAL and then held while the user
   * picks GOLD is still a universal target, and a screen that reads the selection
   * would present it as a gold-specific recommendation. That is a claim the app
   * would be making on the engine's behalf without the engine having made it.
   *
   * The field makes the difference visible instead of leaving it to be inferred.
   */
  scoredForCommodity: string | null;
}

export interface TargetingResult {
  /** The cell the geologist is standing in, and what is under their feet. */
  current: { cell: string; context: GeoContext; score: number; coverage: EvidenceCoverage };
  /** Ranked, best first. Empty when nothing scores — which is a real answer. */
  targets: ExplorationTarget[];
  /** False when no pack is installed: the app has no knowledge here. */
  hasKnowledge: boolean;
  /** True when the current cell already scores at least as well as the best neighbour. */
  bestIsHere: boolean;
}

export interface TargetingOptions {
  /** How many H3 rings out to search. 2 rings ≈ 10–15 km at resolution 7. */
  rings?: number;
  /** Never send a geologist further than this on one leg. */
  maxDistanceM?: number;
  /** Cells scoring below this are not worth walking to. */
  minScore?: number;
  /** How many targets to return. */
  limit?: number;
  radiusM?: number;
  /**
   * Assess for one commodity, by profile code, or `null` for the universal engine.
   *
   * Null is the default and must stay byte-identical to the validated baseline:
   * LOO AUC 0.900, BLIND 0.843. Conditioning is a lens over the same evidence, not
   * a second engine — see commodityModel.
   */
  commodity?: string | null;
}

export const DEFAULT_TARGETING: Required<Omit<TargetingOptions, "radiusM" | "commodity">> = {
  /**
   * Three rings, not two.
   *
   * `maxDistanceM: 15_000` was dead: `kRing(here, 2)` caps the candidate set at
   * about 5.9 km however large the metre limit is, so a target a geologist could
   * SEE eight kilometres away was not a candidate at all and could never be
   * offered. Measured cost of the widening: 128 ms -> 223 ms per ranking, reach
   * 5.9 km -> 8.3 km. Ring 4 was measured at 646 ms, which is a hitch a user
   * feels on every cell crossing, so this stops at three.
   *
   * Beyond this reach, choice comes from `targetAt()` — one named cell at any
   * distance — rather than from scoring an ever-larger disc.
   */
  rings: 3,
  maxDistanceM: 15_000,
  minScore: 0.05,
  /** Six offered, not three: the list is the geologist's choice, not a shortlist. */
  limit: 6,
};

/**
 * Prospectivity evidence for a cell — deliberately NOT the GeoContext's own
 * confidence score.
 *
 * That score answers "how sure am I what is here", which is a different
 * question: a thoroughly mapped but barren cell scores just as high as one
 * sitting on a gold cluster, because both are equally well known. Ranking on it
 * sends a geologist somewhere for no better reason than that the map is good
 * there — the fastest possible way to lose their trust (Architecture risk 7).
 *
 * So prospectivity is built only from evidence that INDICATES MINERALISATION,
 * and scored with the same shared noisy-OR the rest of the system uses. Mapped
 * geology is context, not a signal, and contributes nothing on its own.
 */
export interface Scored {
  item: EvidenceItem;
  reason: TargetReason;
  role: EvidenceRole;
  /**
   * Items sharing a group are the SAME observation seen twice.
   *
   * Noisy-OR assumes independence, and several of these inputs are not
   * independent at all: a fault at 300 m and a "fault-contact intersection at
   * 300 m" are largely one fact; drainage proximity and valley landform are the
   * same low ground described two ways. Combining them as independent evidence
   * systematically over-scores, which is the criticism this project has already
   * had of itself.
   *
   * Within a group the strongest item wins; groups then combine as before.
   * Default is the item's own identity, so anything not explicitly paired
   * behaves exactly as it always has.
   */
  group: string;
}

/**
 * Collapse correlated evidence before combining.
 *
 * Applied everywhere prospectivity items are turned into a score, so the engine
 * and the validation harness can never disagree about what was counted.
 */
export function collapseGroups(scored: readonly Scored[]): EvidenceItem[] {
  const best = new Map<string, EvidenceItem>();
  for (const s of scored) {
    const cur = best.get(s.group);
    if (!cur || s.item.weight > cur.weight) best.set(s.group, s.item);
  }
  return [...best.values()];
}

/**
 * Knobs the VALIDATION harness needs, and nothing else uses.
 *
 * Scoring a known occurrence's own location and finding it prospective proves
 * nothing — the occurrence is in the evidence. Measuring whether this engine
 * ranks mineralised ground above background therefore requires being able to
 * take the answer out of the question, which is what these do. Both default to
 * off, so the app's behaviour is byte-identical without them.
 */
export interface ProspectivityOptions {
  /**
   * Fit the lithology prior WITHOUT the occurrence being tested.
   *
   * Scoring a known occurrence with a prior that counted that occurrence is
   * fitting on the test set. The effect is small — one of 109 — but the harness
   * exists to refuse it, not to argue it is negligible.
   */
  lithologyLeaveOneOut?: boolean;
  /** An externally fitted prior, for validation folds. Defaults to the pack's own. */
  lithologyPrior?: LithologyPrior;
  /** Same, for the landform prior. */
  terrainPrior?: TerrainPrior;
  /**
   * Withhold landform evidence.
   *
   * Terrain was excluded outright until an independent DEM existed. This keeps a
   * switch for the validation harness to measure the engine with and without it,
   * rather than the difference being a matter of opinion.
   */
  blindToTerrain?: boolean;
  /**
   * Ignore occurrences closer than this. At a test point that IS an occurrence,
   * ~100 m removes the subject itself while leaving a real nearby cluster — which
   * is genuine signal a geologist would use.
   */
  excludeOccurrencesWithinM?: number;
  /**
   * Drop ALL occurrence and association evidence. The harder, more honest test:
   * can geology, structure and terrain alone find mineralisation, with no
   * knowledge of where anyone has already found some?
   */
  blindToOccurrences?: boolean;
  /**
   * What the geologist is looking for.
   *
   * ABSENT BY DEFAULT, and absent means the universal model runs exactly as the
   * validation gates measure it — same evidence, same weights, byte for byte.
   * Naming a commodity switches on conditioning read from that commodity's own
   * profile, which those gates cannot measure: the pack holds zero gold
   * occurrences, three tin, one copper. The result is labelled uncalibrated and
   * it is a different claim from the universal score, not a better one.
   */
  commodity?: string | null;
}

/**
 * One authority for what may enter a score.
 *
 * The coverage panel already read ROLES_NOT_SCORED; the scorer did not, so a
 * layer could start contributing the moment its rows appeared in the pack while
 * the panel still reported it as withheld. Both read it now.
 */
function scores(role: EvidenceRole, model: CommodityModel | null): boolean {
  if (!ROLES_NOT_SCORED.includes(role)) return true;
  // A commodity profile can admit a withheld role for its own deposit style —
  // drainage for a placer — and only for that assessment.
  return isRelevant(model, role);
}

export function prospectivityEvidence(
  ctx: GeoContext,
  radiusM: number,
  local?: LocalEvidenceSource,
  pack?: PackData,
  opts: ProspectivityOptions = {},
): Scored[] {
  const items: Scored[] = [];
  const model = pack ? commodityModelFor(pack, opts.commodity) : null;

  // Structure is a real targeting signal, not just context: faults and contacts
  // are where fluids moved and where units meet. An intersection of the two is
  // stronger than either alone and is scored as its own item (§7.7).
  if (pack && pack.mapFeatures.length > 0) {
    const near = featuresNear(pack.mapFeatures, ctx.location.lat, ctx.location.lng, radiusM);
    // FILTER, THEN take the nearest four. Taking four and filtering afterwards
    // worked only while faults were the only lines in the pack: the moment 16,870
    // derived drainage reaches arrived, the four nearest features were almost
    // always channels, faults fell outside the slice, and structural evidence
    // silently stopped contributing. Adding a layer must not remove another.
    const structures = near.filter(
      (f): f is typeof f & { kind: "fault" | "contact" } =>
        f.kind === "fault" || f.kind === "contact",
    );
    // And filter by ADMISSION before the slice too, for the same reason. Withheld
    // contacts were still taking places in the nearest four and being skipped
    // afterwards, so the 1,538 Abbate contacts pushed faults out of the window and
    // cost the model real structural evidence — a layer that is not scored must not
    // be able to displace one that is.
    const scorable = structures.filter(
      (f) => scores(f.kind === "fault" ? "structural" : "contacts", model),
    );
    for (const f of scorable.slice(0, 4)) {
      const role: EvidenceRole = f.kind === "fault" ? "structural" : "contacts";
      const proximity = Math.max(0, 1 - f.distanceM / Math.max(radiusM, 1));
      items.push({
        item: {
          statement: `${f.kind === "fault" ? "Fault" : "Contact"} ${Math.round(f.distanceM)} m away`,
          weight: (f.kind === "fault" ? 0.6 : 0.55) * proximity * factorFor(model, "structural"),
          tier: "mapped",
        },
        reason: { kind: f.kind, distanceM: f.distanceM },
        role,
        group: `structure:${f.id}`,
      });
    }
    // The structures, not every line: an intersection is a fault meeting a
    // contact, and handing it 16,870 drainage reaches to filter out again is
    // work with one possible answer.
    // An intersection is a fault AND a contact, so it inherits the contact's
    // admission. Landing 1,538 real Abbate contacts in the pack switched this term
    // on by itself, past the per-item gate above — a compound term has to be gated
    // on every layer it is compounded from, or a withheld layer walks in wearing
    // another role's name.
    const crossing = scores("contacts", model) ? intersectionsOf(structures) : null;
    if (crossing) {
      items.push({
        item: {
          statement: `Fault and contact intersect within ${Math.round(crossing.distanceM)} m`,
          weight: 0.75 * factorFor(model, "structural"),
          tier: "mapped",
        },
        reason: { kind: "intersection", distanceM: crossing.distanceM },
        // An intersection is a STRUCTURAL statement, and counting it as its own
        // role would let one fault look like two independent layers.
        role: "structural",
        // The intersection IS the nearest structure, restated. Same group, so the
        // stronger of the two is counted and neither is counted twice.
        group: `structure:${near[0]?.id ?? "crossing"}`,
      });
    }
  }

  // ── The rock underfoot ───────────────────────────────────────────────────
  //
  // Not "this ground is mapped", which would reward good survey coverage — but
  // "this CLASS of rock holds most of the known mineralisation in this pack, and
  // covers little of its area". Measured from the pack itself, shrunk toward
  // neutral where the sample is thin, and capped at 0.3 because permissive
  // lithology is the weakest true thing the app can say.
  if (pack) {
    const unit = unitAt(pack, { lat: ctx.location.lat, lng: ctx.location.lng });
    if (unit) {
      const prior = opts.lithologyPrior ?? lithologyPriorFor(pack);
      let w = prior.weightFor(unit.kind, opts.lithologyLeaveOneOut);
      // COMMODITY COMPATIBILITY, and it can only DAMP. The mapped geology is
      // eight broad classes while the profiles name specific lithologies
      // (pegmatite, carbonatite, banded iron formation), so a match cannot be
      // confirmed at this resolution and must not be rewarded. A clear MISMATCH
      // can be acted on: lithium pegmatite in Cenozoic sedimentary cover is
      // unlikely, and saying so costs nothing the map could have told us.
      if (model && model.compatibleRockClasses.size > 0 &&
          !model.compatibleRockClasses.has(unit.kind)) {
        w *= 0.5;
      }
      if (w > 0) {
        const stat = prior.statFor(unit.kind);
        items.push({
          item: {
            statement: `${unit.kind} hosts ${stat?.observed ?? 0} of ${prior.totalObserved} mapped occurrences`,
            weight: w,
            tier: "mapped",
          },
          reason: { kind: "unit", name: unit.name },
          role: "geology",
          group: "lithology",
        });
      }
    }
  }

  // ── The shape of the ground ──────────────────────────────────────────────
  //
  // Measured on the independent Copernicus grid, and capped below lithology
  // because part of what landform predicts is EXPOSURE — whether bedrock can be
  // seen — rather than whether it is mineralised. Useful to an explorer either
  // way, and the statement says landform rather than promising ore.
  if (pack && !opts.blindToTerrain && (pack.terrain?.length ?? 0) > 0) {
    const cell = terrainIndexFor(pack.terrain).nearest(
      ctx.location.lat, ctx.location.lng, TERRAIN_MATCH_M,
    );
    if (cell) {
      const prior = opts.terrainPrior ?? terrainPriorFor(pack);
      const w = prior.weightFor(cell.morphology, opts.lithologyLeaveOneOut) *
        factorFor(model, "terrain");
      if (w > 0) {
        const stat = prior.statFor(cell.morphology);
        items.push({
          item: {
            statement:
              `${cell.morphology} landform — ${stat?.observed ?? 0} of ` +
              `${prior.totalObserved} mapped occurrences sit on this landform`,
            weight: w,
            tier: "mapped",
          },
          reason: { kind: "unit", name: cell.morphology },
          role: "terrain",
          // Landform and drainage proximity describe the same low ground.
          group: "landform",
        });
      }
    }
  }

  // ── Drainage, for placer systems only ────────────────────────────────────
  //
  // OFF in the universal model, and it stays off: measured occurrence enrichment
  // by distance-to-channel is flat (1.11, 1.18, 0.86, 1.03, 1.01), so a universal
  // weight would be an invention.
  //
  // ON when the commodity's own deposit models are placer or alluvial, because a
  // placer IS a channel deposit — an engine asked about placer gold that ignores
  // where the water runs is answering a different question. The weight is
  // UNCALIBRATED and the smallest in the engine: the pack contains zero
  // occurrences described as placer, so there is nothing to fit it to, and it is
  // grouped with landform because valley floor and channel proximity are the same
  // low ground described twice.
  if (pack && isRelevant(model, "drainage")) {
    const channels = linesNear(
      pack.mapFeatures ?? [], ctx.location.lat, ctx.location.lng, DRAINAGE_PLACER_REACH_M,
    ).filter((f) => f.kind === "drainage");
    const nearest = channels[0];
    if (nearest) {
      const proximity = Math.max(0, 1 - nearest.distanceM / DRAINAGE_PLACER_REACH_M);
      const w = DRAINAGE_PLACER_WEIGHT * proximity * factorFor(model, "drainage");
      if (w > 0) {
        items.push({
          item: {
            statement:
              `Drainage channel ${Math.round(nearest.distanceM)} m away — ` +
              `relevant because ${model!.code} includes a placer deposit model`,
            weight: w,
            tier: "mapped",
          },
          reason: { kind: "contact", distanceM: nearest.distanceM },
          role: "drainage",
          // Same low ground as the valley landform term. Counted once.
          group: "landform",
        });
      }
    }
  }

  // The geologist's own observations (step 7): what they just found changes
  // where they should go next. This is the feedback that makes the loop a loop.
  if (local) {
    for (const o of local.observationsNear(ctx.location.lat, ctx.location.lng, radiusM)) {
      // The geologist recorded a TYPE — gossan, sulfides, a quartz vein. Which of
      // those means anything depends on what is being looked for, and the profile
      // says: gold lists "quartz veins in shear zones", "sulphide veinlets",
      // "gossan/iron staining". Nothing is invented; a type the profile does not
      // name simply keeps its own weight.
      const diagnostic = model?.diagnosticObservations.has(o.type) ?? false;
      items.push({
        item: {
          statement: o.statement,
          weight: Math.min(1, o.weight * (diagnostic ? 1.25 : 1)),
          tier: "mapped",
        },
        reason: { kind: "observation", label: o.type, distanceM: o.distanceM },
        role: "field",
        group: `field:${o.id}`,
      });
    }
  }

  let occurrenceSeq = 0;
  for (const o of (opts.blindToOccurrences ? [] : ctx.knownOccurrences ?? [])) {
    const d = Number(o.distanceM ?? radiusM);
    // Validation only: the occurrence under test is not evidence for itself.
    if (opts.excludeOccurrencesWithinM != null && d < opts.excludeOccurrencesWithinM) continue;
    // Same linear falloff the occurrence provider uses, so near evidence
    // outweighs far evidence identically on both sides.
    const proximity = Math.max(0.2, Math.min(0.9, 1 - d / Math.max(radiusM, 1)));
    const commodity = typeof o.commodity === "string" ? o.commodity : "Mineral";
    items.push({
      item: {
        statement: `${commodity} occurrence ${Math.round(d)} m away`,
        weight: proximity,
        tier: "mapped",
      },
      reason: { kind: "occurrence", commodity, distanceM: d },
      role: "occurrence",
      // EACH ITS OWN. Two mapped occurrences near a point are two separate finds
      // recorded by MRDS, not one observation restated — so they combine as
      // independent evidence, exactly as they always have. Keying on reference or
      // distance would silently merge two records that happen to share either.
      group: `occurrence:${occurrenceSeq++}`,
    });
  }

  for (const a of (opts.blindToOccurrences ? [] : ctx.commodityAssociations ?? [])) {
    const commodity = typeof a.commodity === "string" ? a.commodity : null;
    if (!commodity) continue;
    const w = typeof a.weight === "number" ? a.weight : 0.5;
    items.push({
      item: {
        // Knowledge enriches but must not inflate: capped well below observation.
        statement: `${commodity} is associated with the host rocks here`,
        weight: Math.min(0.35, w),
      },
      reason: { kind: "association", commodity },
      role: "association",
      // An association is DERIVED from the host rock the occurrence sits in, so it
      // shares a group with the lithology term rather than adding to it.
      group: "lithology",
    });
  }

  const verified = Number(ctx.communityEvidence?.verifiedScans ?? 0);
  if (verified > 0) {
    items.push({
      item: {
        statement: `${verified} verified find${verified === 1 ? "" : "s"} recorded nearby`,
        weight: 0.4,
        tier: "community",
      },
      reason: { kind: "community", count: verified },
      role: "community",
      group: "community",
    });
  }

  return items;
}

/** Commodity names the evidence at a cell points at, most-cited first. */
function commoditiesOf(ctx: GeoContext): string[] {
  const counts = new Map<string, number>();
  for (const o of ctx.knownOccurrences ?? []) {
    const c = typeof o.commodity === "string" ? o.commodity : null;
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  for (const a of ctx.commodityAssociations ?? []) {
    const c = typeof a.commodity === "string" ? a.commodity : null;
    if (c) counts.set(c, (counts.get(c) ?? 0) + 0.5);
  }
  return [...counts.entries()].sort((x, y) => y[1] - x[1]).map(([c]) => c);
}

/**
 * The reasons a target is worth walking to, strongest first.
 *
 * Structured, not prose: the UI renders them in English or Somali. The mapped
 * unit follows the mineralisation signals as context, because context is not
 * why anyone should walk somewhere (Invariant 2 with Invariant 4).
 */
function reasonsFor(ctx: GeoContext, scored: Scored[]): TargetReason[] {
  const out: TargetReason[] = [...scored]
    .sort((a, b) => b.item.weight - a.item.weight)
    .slice(0, 3)
    .map((x) => x.reason);
  const unit = ctx.geology?.unit;
  if (unit) out.push({ kind: "unit", name: unit });
  return out;
}

/**
 * Coverage from the evidence that was ACTUALLY produced, not from a second guess.
 *
 * With no pack there is nothing to report against, so an empty pack yields a
 * report where everything is unavailable — which is the truth, not a failure.
 */
function coverageFor(
  pack: PackData | undefined,
  scored: Scored[],
  at: { lat: number; lng: number },
): EvidenceCoverage {
  const produced = new Set<EvidenceRole>(scored.map((x) => x.role));
  return coverageAt(pack ?? EMPTY_PACK, produced, at);
}

const EMPTY_PACK: PackData = {
  geology: [], occurrences: [], knowledge: [], structures: [], community: [],
  mapFeatures: [], terrain: [], associations: [], rules: [], commodities: [],
  assemblages: [], land: [],
};

export class TargetingEngine {
  constructor(
    private readonly geo: OfflineGeoContextService,
    private readonly local?: LocalEvidenceSource,
    /** Pack access for the structural signals; omitted, targeting simply has fewer inputs. */
    private readonly pack?: () => PackData,
  ) {}

  /**
   * Rank the neighbourhood. One GeoContext is computed per candidate cell —
   * all in memory, against the pack, with no network.
   */
  /**
   * Score ONE cell and describe it as a target.
   *
   * Factored out of the ranking loop so `targetAt` cannot diverge from it: a cell
   * the user picks by hand must be scored by exactly the code that scores the ones
   * the engine offers, or the two would eventually disagree about the same ground.
   *
   * Returns null when the cell has nothing to say about itself — Invariant 2: a
   * target with no reasons is not offered, however it was chosen.
   */
  private async buildTarget(
    cell: string,
    from: { lat: number; lng: number },
    radiusM: number,
    scoringOpts: ProspectivityOptions,
    packData: PackData | undefined,
    // Shared across every candidate in one rank() call — see rank()'s own
    // comment. Omitted by targetAt(), which scores exactly one cell and gets
    // nothing from batching, so it keeps calling contextAt() directly.
    query?: GeoContextQuery,
  ): Promise<ExplorationTarget | null> {
    const centre = cellCentre(cell);
    const distanceM = haversineM(from, centre);
    const run = query ?? ((lat, lng, opts) => this.geo.contextAt(lat, lng, opts));
    const { context } = await run(centre.lat, centre.lng, { radiusM });
    const scored = prospectivityEvidence(context, radiusM, this.local, packData, scoringOpts);
    const score = computeConfidence(collapseGroups(scored)).score;
    const reasons = reasonsFor(context, scored);
    if (reasons.length === 0) return null;
    const bearing = bearingDeg(from, centre);
    return {
      cell, centre, bearingDeg: bearing, compass: compassPoint(bearing),
      distanceM, score, band: bandFor(score), reasons,
      commodities: commoditiesOf(context),
      coverage: coverageFor(packData, scored, centre),
      scoredForCommodity: scoringOpts.commodity ?? null,
    };
  }

  /**
   * A target at a place the USER named, at ANY distance.
   *
   * The ranking answers "where should I go next within walking reach". This
   * answers "I want to go THERE" — a hill the geologist can see, a lead eighty
   * kilometres off, a coordinate from a colleague. No ring, no distance cap, no
   * minimum score: the engine's opinion is reported, not used as a gate, because
   * refusing to route somewhere a geologist has decided to go is not the app's
   * decision to make.
   *
   * Null only when the cell has nothing to say at all — and that is reported as
   * such rather than silently ignored.
   */
  async targetAt(
    from: { lat: number; lng: number },
    at: { lat: number; lng: number },
    opts: TargetingOptions = {},
  ): Promise<ExplorationTarget | null> {
    const radiusM = opts.radiusM ?? DEFAULT_CONTEXT_RADIUS_M;
    // Same ordering rule as rank(): contextAt is what loads the pack.
    await this.geo.contextAt(from.lat, from.lng, { radiusM });
    const packData = this.pack?.();
    return this.buildTarget(
      cellFor(at.lat, at.lng), from, radiusM,
      { commodity: opts.commodity ?? null }, packData,
    );
  }

  async rank(lat: number, lng: number, opts: TargetingOptions = {}): Promise<TargetingResult> {
    const o = { ...DEFAULT_TARGETING, ...opts };
    const here = cellFor(lat, lng);
    const radiusM = opts.radiusM ?? DEFAULT_CONTEXT_RADIUS_M;
    const candidates = kRing(here, o.rings).filter((c) => c !== here);

    // PERF (not scoring): one engine/gateway for the current cell AND every
    // candidate, instead of one per contextAt() call — see openBatch()'s own
    // comment for the measured cost this replaces. `query` runs the identical
    // providers/gateway/query-shape contextAt() always has; only the
    // construction is shared, so this changes nothing about what is computed.
    // Named with the candidate count so a slow ranking is attributed to a
    // ring size, not just to "targeting.rank" in general.
    const done = markPhase(`targeting.rank[${candidates.length + 1}]`);
    try {
      const query = await this.geo.openBatch();

      // AFTER the first query, never before: the geo service is what loads the
      // pack, and reading it earlier hands back an empty one. Hoisting this out
      // of the loop for tidiness silently removed every structural target.
      const currentResult = await query(lat, lng, { radiusM });
      const packData = this.pack?.();
      // One options object for the cell under foot and every candidate: a target
      // ranked for a different commodity than the ground it is compared against
      // would be a comparison of two different questions.
      const scoringOpts: ProspectivityOptions = { commodity: opts.commodity ?? null };
      const currentScored = prospectivityEvidence(
        currentResult.context, radiusM, this.local, packData, scoringOpts,
      );
      const currentScore = computeConfidence(collapseGroups(currentScored)).score;
      const currentCoverage = coverageFor(packData, currentScored, { lat, lng });

      const targets: ExplorationTarget[] = [];

      for (const cell of candidates) {
        const built = await this.buildTarget(cell, { lat, lng }, radiusM, scoringOpts, packData, query);
        if (!built) continue;
        if (built.distanceM > o.maxDistanceM) continue;
        if (built.score < o.minScore) continue; // nothing indicating mineralisation
        targets.push(built);
      }

      // Best first; nearer wins a tie, so a geologist is never sent further for
      // the same expected value.
      targets.sort((a, b) => (b.score - a.score) || (a.distanceM - b.distanceM));

      const best = targets[0];
      return {
        current: {
          cell: here, context: currentResult.context,
          score: currentScore, coverage: currentCoverage,
        },
        targets: targets.slice(0, o.limit),
        hasKnowledge: currentResult.hasKnowledge,
        bestIsHere: !best || currentScore >= best.score,
      };
    } finally {
      done();
    }
  }
}

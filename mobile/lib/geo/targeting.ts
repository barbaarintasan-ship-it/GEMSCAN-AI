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
import { DEFAULT_CONTEXT_RADIUS_M, type OfflineGeoContextService } from "./offlineGeoContext.ts";
import type { LocalEvidenceSource } from "../exploration/localEvidence.ts";
import { featuresNear, intersectionsOf } from "./terrainProviders.ts";
import type { PackData } from "../../../shared/geo-core/pack/types.ts";

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
}

export interface TargetingResult {
  /** The cell the geologist is standing in, and what is under their feet. */
  current: { cell: string; context: GeoContext; score: number };
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
}

export const DEFAULT_TARGETING: Required<Omit<TargetingOptions, "radiusM">> = {
  rings: 2,
  maxDistanceM: 15_000,
  minScore: 0.05,
  limit: 3,
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
interface Scored { item: EvidenceItem; reason: TargetReason }

function prospectivityEvidence(
  ctx: GeoContext,
  radiusM: number,
  local?: LocalEvidenceSource,
  pack?: PackData,
): Scored[] {
  const items: Scored[] = [];

  // Structure is a real targeting signal, not just context: faults and contacts
  // are where fluids moved and where units meet. An intersection of the two is
  // stronger than either alone and is scored as its own item (§7.7).
  if (pack && pack.mapFeatures.length > 0) {
    const near = featuresNear(pack.mapFeatures, ctx.location.lat, ctx.location.lng, radiusM);
    for (const f of near.slice(0, 4)) {
      if (f.kind !== "fault" && f.kind !== "contact") continue;
      const proximity = Math.max(0, 1 - f.distanceM / Math.max(radiusM, 1));
      items.push({
        item: {
          statement: `${f.kind === "fault" ? "Fault" : "Contact"} ${Math.round(f.distanceM)} m away`,
          weight: (f.kind === "fault" ? 0.6 : 0.55) * proximity,
          tier: "mapped",
        },
        reason: { kind: f.kind, distanceM: f.distanceM },
      });
    }
    const crossing = intersectionsOf(near);
    if (crossing) {
      items.push({
        item: {
          statement: `Fault and contact intersect within ${Math.round(crossing.distanceM)} m`,
          weight: 0.75,
          tier: "mapped",
        },
        reason: { kind: "intersection", distanceM: crossing.distanceM },
      });
    }
  }

  // The geologist's own observations (step 7): what they just found changes
  // where they should go next. This is the feedback that makes the loop a loop.
  if (local) {
    for (const o of local.observationsNear(ctx.location.lat, ctx.location.lng, radiusM)) {
      items.push({
        item: { statement: o.statement, weight: o.weight, tier: "mapped" },
        reason: { kind: "observation", label: o.type, distanceM: o.distanceM },
      });
    }
  }

  for (const o of ctx.knownOccurrences ?? []) {
    const d = Number(o.distanceM ?? radiusM);
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
    });
  }

  for (const a of ctx.commodityAssociations ?? []) {
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
  async rank(lat: number, lng: number, opts: TargetingOptions = {}): Promise<TargetingResult> {
    const o = { ...DEFAULT_TARGETING, ...opts };
    const here = cellFor(lat, lng);

    const radiusM = opts.radiusM ?? DEFAULT_CONTEXT_RADIUS_M;
    const currentResult = await this.geo.contextAt(lat, lng, { radiusM });
    const currentScore = computeConfidence(
      prospectivityEvidence(currentResult.context, radiusM, this.local, this.pack?.())
        .map((x) => x.item),
    ).score;

    const candidates = kRing(here, o.rings).filter((c) => c !== here);
    const targets: ExplorationTarget[] = [];

    for (const cell of candidates) {
      const centre = cellCentre(cell);
      const distanceM = haversineM({ lat, lng }, centre);
      if (distanceM > o.maxDistanceM) continue;

      const { context } = await this.geo.contextAt(centre.lat, centre.lng, { radiusM });
      const scored = prospectivityEvidence(context, radiusM, this.local, this.pack?.());
      // Same shared noisy-OR the server uses — no new confidence maths here.
      const score = computeConfidence(scored.map((x) => x.item)).score;
      if (score < o.minScore) continue; // nothing indicating mineralisation ⇒ not a target

      const reasons = reasonsFor(context, scored);
      // Invariant 2: a target with nothing to say about itself is not offered.
      if (reasons.length === 0) continue;

      const bearing = bearingDeg({ lat, lng }, centre);
      targets.push({
        cell,
        centre,
        bearingDeg: bearing,
        compass: compassPoint(bearing),
        distanceM,
        score,
        band: bandFor(score),
        reasons,
        commodities: commoditiesOf(context),
      });
    }

    // Best first; nearer wins a tie, so a geologist is never sent further for
    // the same expected value.
    targets.sort((a, b) => (b.score - a.score) || (a.distanceM - b.distanceM));

    const best = targets[0];
    return {
      current: { cell: here, context: currentResult.context, score: currentScore },
      targets: targets.slice(0, o.limit),
      hasKnowledge: currentResult.hasKnowledge,
      bestIsHere: !best || currentScore >= best.score,
    };
  }
}

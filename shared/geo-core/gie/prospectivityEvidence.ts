// prospectivityEvidence() — the ONE evidence-generation function behind every
// prospectivity number in this codebase (ranking `score`, display `reportScore`,
// and the Integrated Prospectivity Score all consume its output).
//
// MOVED from mobile/lib/geo/targeting.ts (Solo→Team shared-targeting Phase 1),
// so Team Mission Mode can call the SAME deterministic evidence/scoring logic
// Solo Exploration already uses — see docs from the Solo↔Team audit. This file
// changes NOTHING about the algorithm: every weight, cap and formula below is
// byte-identical to the version that shipped in mobile/lib/geo/targeting.ts.
// mobile/lib/geo/targeting.ts is now a re-export shim over this module plus a
// small mobile-only wiring layer (h3, perf pacing, and the pack-derived
// structural/lithology/terrain priors — see `PackPriorOps` below).
//
// WHY SOME INPUTS ARE INJECTED RATHER THAN IMPORTED
//
// Four of Solo's evidence sources — the mapped-unit lookup, the fitted
// lithology/terrain priors, and the pack coverage report — are computed from
// `PackData`, the BUNDLED OFFLINE PACK a mobile device carries. Building an
// equivalent live pack server-side is real, separate work (tracked as a later
// phase), so this module accepts those four as an OPTIONAL `PackPriorOps`
// parameter instead of importing mobile's pack-reading modules directly:
//   - Solo (mobile/lib/geo/targeting.ts) always supplies the real ones, so Solo's
//     output is UNCHANGED — same functions, same call sites, just threaded
//     through one more parameter.
//   - Team (server-side, Phase 1) omits them, and gets the SAME formula over
//     whatever evidence it does have (occurrences, associations, community,
//     field/local observations) — an honest, deterministic, narrower score,
//     not a fabricated one. Structural (fault/contact) evidence is NOT in this
//     injected set — `featuresNear`/`intersectionsOf` have no h3 dependency and
//     are imported directly from ../geo/mapFeatures.ts, so Team gets structural
//     evidence too, the moment `pack.mapFeatures` is populated from a live
//     source (a `pack` object can be constructed and passed in without needing
//     PackPriorOps at all, for exactly this evidence family).
//
// Do not add a second implementation of any of this. Any new caller — Team or
// otherwise — must import from here.
import type { EvidenceRole } from "../geo/evidenceRoles.ts";
import { ROLES_NOT_SCORED, EVIDENCE_ROLES, ROLES_WITHOUT_SOURCE } from "../geo/evidenceRoles.ts";
import { featuresNear, intersectionsOf } from "../geo/mapFeatures.ts";
import {
  commodityModelFor, factorFor, isRelevant,
  DRAINAGE_PLACER_REACH_M, DRAINAGE_PLACER_WEIGHT, type CommodityModel,
} from "../geo/commodityModel.ts";
import type { GeoContext, EvidenceItem } from "../types.ts";
import type { PackData, PackTerrainCell } from "../pack/types.ts";

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

/**
 * Prospectivity evidence for a cell — deliberately NOT the GeoContext's own
 * confidence score. See the original architecture note (mobile/lib/geo/targeting.ts)
 * for why: mapped geology is context, not a signal, and contributes nothing on
 * its own.
 */
export interface Scored {
  item: EvidenceItem;
  reason: TargetReason;
  role: EvidenceRole;
  /**
   * Items sharing a group are the SAME observation seen twice — see
   * collapseGroups(). Default is the item's own identity, so anything not
   * explicitly paired behaves exactly as it always has.
   */
  group: string;
}

/** Collapse correlated evidence before combining — same rule everywhere. */
export function collapseGroups(scored: readonly Scored[]): EvidenceItem[] {
  const best = new Map<string, EvidenceItem>();
  for (const s of scored) {
    const cur = best.get(s.group);
    if (!cur || s.item.weight > cur.weight) best.set(s.group, s.item);
  }
  return [...best.values()];
}

/** A fitted prior's read surface — lithologyPrior.ts / terrainPrior.ts (Solo-only, injected). */
export interface FittedPrior {
  weightFor(kind: string, leaveOneOut?: boolean): number;
  statFor(kind: string): { observed: number } | null | undefined;
  totalObserved: number;
}

/** terrainIndex.ts's read surface (Solo-only, injected — needs h3 to build). */
export interface TerrainIndexLike {
  nearest(lat: number, lng: number, maxM: number): (PackTerrainCell & { fromM: number }) | null;
}

export interface RoleCoverage { role: EvidenceRole; state: "present" | "not_scored" | "none_here" | "empty_layer" | "no_source" }
export interface EvidenceCoverage {
  roles: RoleCoverage[];
  present: number;
  total: number;
  unavailable: EvidenceRole[];
}

/**
 * The four pack-derived inputs that need mobile's bundled `PackData` and (for
 * three of them) h3 to build an index — see this file's header note. Solo
 * supplies all five; Team (Phase 1) supplies none, and gets an honestly
 * narrower — never fabricated — evidence set in return.
 */
export interface PackPriorOps {
  unitAt(pack: PackData, at: { lat: number; lng: number }): { kind: string; name: string } | null;
  lithologyPriorFor(pack: PackData): FittedPrior;
  terrainPriorFor(pack: PackData): FittedPrior;
  terrainIndexFor(cells: PackTerrainCell[]): TerrainIndexLike;
  coverageAt(
    pack: PackData | undefined,
    produced: ReadonlySet<EvidenceRole>,
    at: { lat: number; lng: number },
  ): EvidenceCoverage;
}

/** What the targeting engine and the local-evidence provider both read. */
export interface Observation {
  id?: string;
  type: string;
  distanceM: number;
  weight: number;
  statement: string;
  role?: EvidenceRole;
  tier?: string;
  group?: string;
}

/** A source of the geologist's (or, in future, a team's) own observations. */
export interface LocalEvidenceSource {
  observationsNear(lat: number, lng: number, radiusM: number): Observation[];
}

/**
 * Knobs the VALIDATION harness needs, and nothing else uses. Both default to
 * off, so behaviour is byte-identical without them.
 */
export interface ProspectivityOptions {
  /** Fit the lithology prior WITHOUT the occurrence being tested. */
  lithologyLeaveOneOut?: boolean;
  /** An externally fitted prior, for validation folds. Defaults to the pack's own. */
  lithologyPrior?: FittedPrior;
  /** Same, for the landform prior. */
  terrainPrior?: FittedPrior;
  /** Withhold landform evidence. */
  blindToTerrain?: boolean;
  /** Ignore occurrences closer than this (validation only). */
  excludeOccurrencesWithinM?: number;
  /** Drop ALL occurrence and association evidence (validation only). */
  blindToOccurrences?: boolean;
  /**
   * What the geologist is looking for. ABSENT BY DEFAULT — see targeting.ts's
   * own note: this must stay byte-identical to the validated universal
   * baseline (LOO AUC 0.900, BLIND 0.843) when null.
   */
  commodity?: string | null;
}

/**
 * One authority for what may enter a score.
 */
function scores(role: EvidenceRole, model: CommodityModel | null): boolean {
  if (!ROLES_NOT_SCORED.includes(role)) return true;
  return isRelevant(model, role);
}

export function prospectivityEvidence(
  ctx: GeoContext,
  radiusM: number,
  local?: LocalEvidenceSource,
  pack?: PackData,
  opts: ProspectivityOptions = {},
  packOps?: PackPriorOps,
): Scored[] {
  const items: Scored[] = [];
  const model = pack ? commodityModelFor(pack, opts.commodity) : null;

  // Structure is a real targeting signal, not just context: faults and contacts
  // are where fluids moved and where units meet. Pure — no injection needed.
  if (pack && pack.mapFeatures.length > 0) {
    const near = featuresNear(pack.mapFeatures, ctx.location.lat, ctx.location.lng, radiusM);
    const structures = near.filter(
      (f): f is typeof f & { kind: "fault" | "contact" } =>
        f.kind === "fault" || f.kind === "contact",
    );
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
    const crossing = scores("contacts", model) ? intersectionsOf(structures) : null;
    if (crossing) {
      items.push({
        item: {
          statement: `Fault and contact intersect within ${Math.round(crossing.distanceM)} m`,
          weight: 0.75 * factorFor(model, "structural"),
          tier: "mapped",
        },
        reason: { kind: "intersection", distanceM: crossing.distanceM },
        role: "structural",
        group: `structure:${near[0]?.id ?? "crossing"}`,
      });
    }
  }

  // ── The rock underfoot ─────────────────────────────────────────────────
  // Injected: needs the pack's fitted lithology prior + the unit lookup, both
  // of which need mobile's h3-backed spatial index to build (see header note).
  if (pack && packOps) {
    const unit = packOps.unitAt(pack, { lat: ctx.location.lat, lng: ctx.location.lng });
    if (unit) {
      const prior = opts.lithologyPrior ?? packOps.lithologyPriorFor(pack);
      let w = prior.weightFor(unit.kind, opts.lithologyLeaveOneOut);
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

  // ── The shape of the ground ────────────────────────────────────────────
  // Injected — same reason as lithology above.
  if (pack && packOps && !opts.blindToTerrain && (pack.terrain?.length ?? 0) > 0) {
    const TERRAIN_MATCH_M = 5_000;
    const cell = packOps.terrainIndexFor(pack.terrain).nearest(
      ctx.location.lat, ctx.location.lng, TERRAIN_MATCH_M,
    );
    if (cell) {
      const prior = opts.terrainPrior ?? packOps.terrainPriorFor(pack);
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
          group: "landform",
        });
      }
    }
  }

  // ── Drainage, for placer systems only ──────────────────────────────────
  // Pure — no injection needed (reuses featuresNear).
  if (pack && isRelevant(model, "drainage")) {
    const channels = featuresNear(
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
          group: "landform",
        });
      }
    }
  }

  // The geologist's (or a team contributor's) own observations: what they just
  // found changes where they should go next.
  if (local) {
    for (const o of local.observationsNear(ctx.location.lat, ctx.location.lng, radiusM)) {
      const diagnostic = model?.diagnosticObservations.has(o.type) ?? false;
      items.push({
        item: {
          statement: o.statement,
          weight: Math.min(1, o.weight * (diagnostic ? 1.25 : 1)),
          tier: o.tier ?? "mapped",
        },
        reason: { kind: "observation", label: o.type, distanceM: o.distanceM },
        role: o.role ?? "field",
        group: o.group ?? `field:${o.id ?? o.statement}`,
      });
    }
  }

  let occurrenceSeq = 0;
  for (const o of (opts.blindToOccurrences ? [] : ctx.knownOccurrences ?? [])) {
    const d = Number(o.distanceM ?? radiusM);
    if (opts.excludeOccurrencesWithinM != null && d < opts.excludeOccurrencesWithinM) continue;
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
      group: `occurrence:${occurrenceSeq++}`,
    });
  }

  for (const a of (opts.blindToOccurrences ? [] : ctx.commodityAssociations ?? [])) {
    const commodity = typeof a.commodity === "string" ? a.commodity : null;
    if (!commodity) continue;
    const w = typeof a.weight === "number" ? a.weight : 0.5;
    items.push({
      item: {
        statement: `${commodity} is associated with the host rocks here`,
        weight: Math.min(0.35, w),
      },
      reason: { kind: "association", commodity },
      role: "association",
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
export function commoditiesOf(ctx: GeoContext): string[] {
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
 */
export function reasonsFor(ctx: GeoContext, scored: Scored[]): TargetReason[] {
  const out: TargetReason[] = [...scored]
    .sort((a, b) => b.item.weight - a.item.weight)
    .slice(0, 3)
    .map((x) => x.reason);
  const unit = ctx.geology?.unit;
  if (unit) out.push({ kind: "unit", name: unit });
  return out;
}

/**
 * Coverage without a pack (Team, Phase 1): honest about what could not be
 * computed rather than borrowing Solo's EMPTY_PACK convention, which would
 * misreport roles that DID produce evidence here (occurrence/association/
 * community all come from GeoContext, not from a pack) as `empty_layer`.
 */
function coverageWithoutPack(produced: ReadonlySet<EvidenceRole>): EvidenceCoverage {
  const roles: RoleCoverage[] = EVIDENCE_ROLES.map((role) => ({
    role,
    state: produced.has(role)
      ? "present"
      : ROLES_WITHOUT_SOURCE.includes(role) ? "no_source" : "empty_layer",
  }));
  return {
    roles,
    present: roles.filter((r) => r.state === "present").length,
    total: EVIDENCE_ROLES.length,
    unavailable: roles.filter((r) => r.state === "empty_layer" || r.state === "no_source").map((r) => r.role),
  };
}

/**
 * Coverage from the evidence that was ACTUALLY produced.
 *
 * Solo always supplies `packOps.coverageAt` (a thin adapter over the real
 * evidenceCoverage.ts, which needs mobile's h3-backed pack index) so its
 * output is unchanged. Without it — Team, Phase 1 — falls back to the honest,
 * pack-free accounting above.
 */
export function coverageFor(
  pack: PackData | undefined,
  packOps: PackPriorOps | undefined,
  scored: Scored[],
  at: { lat: number; lng: number },
): EvidenceCoverage {
  const produced = new Set<EvidenceRole>(scored.map((x) => x.role));
  if (packOps) return packOps.coverageAt(pack, produced, at);
  return coverageWithoutPack(produced);
}

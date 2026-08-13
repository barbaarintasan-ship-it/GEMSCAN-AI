// Does the prospectivity score point at ground worth walking to?
//
// Nobody had ever asked. The engine has been ranking targets, drawing arrows and
// quoting travel times for a well-built, well-tested number that had never once
// been checked against reality. This module is that check, and it exists before
// the commodity work because it is the only thing that can say whether the
// commodity work helped.
//
// THE QUESTION, stated so a machine can answer it:
//
//   Do the 159 mapped mineral occurrences score higher than random Somali ground?
//
// THE TRAP, which is why this is more than a for-loop. Score an occurrence's own
// location and of course it scores high — the occurrence is IN the evidence. That
// measures nothing but the plumbing. So the subject is removed from the question
// (`excludeOccurrencesWithinM`), and a second, harder run removes occurrence
// evidence altogether (`blindToOccurrences`): can geology, structure and terrain
// find mineralisation with no knowledge of where anyone already found some?
//
// Everything here is pure and deterministic — the sampler takes a seeded RNG — so
// a baseline recorded today is a baseline that can be compared with tomorrow.
import { pointInRings } from "./featureInfo";
import type { EvidenceRole } from "./evidenceRoles";
import type { PackData } from "../../../shared/geo-core/pack/types";

export interface ScoredPoint {
  lat: number;
  lng: number;
  score: number;
  /** What the point is, not what the engine thought it was. */
  label: "occurrence" | "background";
  /** For occurrences: what is actually there, so a failure can be read. */
  commodity?: string | null;
  /** Which evidence roles produced anything at this point. Drives leakage detection. */
  roles?: readonly EvidenceRole[];
}

export interface ValidationMetrics {
  occurrenceCount: number;
  backgroundCount: number;
  medianOccurrence: number;
  medianBackground: number;
  /** Positive means occurrences score higher. Zero means the engine is blind. */
  medianDifference: number;
  /**
   * Probability that a random occurrence outranks a random background point.
   *
   * 0.5 is a coin toss — the honest reading of "this model knows nothing". 1.0 is
   * perfect separation. Computed by rank (Mann–Whitney), with ties counted as
   * half, because a model that gives everything the same score must score 0.5 and
   * not accidentally 1.0.
   */
  auc: number;
  /**
   * How many times more occurrences land in the top-scoring decile than chance.
   *
   * This is the number a geologist actually cares about: if I walk the best 10% of
   * the ground this thing shows me, how much better than random am I doing? 1.0 is
   * no better. It is reported alongside AUC because AUC can look respectable while
   * the top of the ranking — the only part anyone acts on — is worthless.
   */
  topDecileLift: number;
  /** Fraction of points that scored exactly zero. High means "no opinion", not "barren". */
  zeroScoreRate: number;
}

export interface ValidationRun {
  name: string;
  metrics: ValidationMetrics;
  points: ScoredPoint[];
}

// ── Sampling ────────────────────────────────────────────────────────────────

/**
 * A seeded generator, so a baseline is reproducible.
 *
 * mulberry32 — small, well-distributed, and not the platform's `Math.random`,
 * which would make every run's background set different and every comparison
 * meaningless.
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random points on LAND, inside the pack's coverage.
 *
 * Land matters. Comparing occurrences against points in the Gulf of Aden would
 * produce a flattering AUC that says nothing: the model would only be proving it
 * can tell sea from rock. The pack carries a coastline for exactly this reason,
 * so background is drawn from ground a geologist could actually stand on.
 *
 * Returns fewer than `n` rather than looping for ever if the land test keeps
 * failing — an honest short sample beats a hang.
 */
export function randomLandPoints(
  pack: PackData,
  bbox: [number, number, number, number],
  n: number,
  rng: () => number,
  maxAttempts = n * 200,
): Array<{ lat: number; lng: number }> {
  const land = pack.land ?? [];
  const out: Array<{ lat: number; lng: number }> = [];
  const [w, s, e, nth] = bbox;

  for (let i = 0; i < maxAttempts && out.length < n; i++) {
    const lng = w + rng() * (e - w);
    const lat = s + rng() * (nth - s);
    // No coastline in the pack ⇒ every point is accepted, and the run says so
    // rather than silently comparing against the sea.
    if (land.length > 0 && !land.some((p) => pointInRings(p.rings, { lat, lng }))) continue;
    out.push({ lat, lng });
  }
  return out;
}

// ── Metrics ─────────────────────────────────────────────────────────────────

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const v = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * AUC by rank, ties shared.
 *
 * Equivalent to the Mann–Whitney U statistic over the two score sets. Written out
 * rather than pulled in, because a dependency for twenty lines of arithmetic is a
 * dependency a field app has to ship.
 */
export function auc(positives: readonly number[], negatives: readonly number[]): number {
  if (positives.length === 0 || negatives.length === 0) return 0.5;

  const all = [
    ...positives.map((s) => ({ s, pos: true })),
    ...negatives.map((s) => ({ s, pos: false })),
  ].sort((a, b) => a.s - b.s);

  // Average ranks within each tied block, so a model that scores everything the
  // same lands on 0.5 instead of on whichever side the sort happened to favour.
  const ranks = new Array<number>(all.length);
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].s === all[i].s) j++;
    const shared = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = shared;
    i = j + 1;
  }

  let rankSumPos = 0;
  for (let k = 0; k < all.length; k++) if (all[k].pos) rankSumPos += ranks[k];

  const nP = positives.length, nN = negatives.length;
  const u = rankSumPos - (nP * (nP + 1)) / 2;
  return u / (nP * nN);
}

/**
 * How concentrated the positives are in the best-scoring decile, over chance.
 *
 * Ties at the decile boundary are the awkward case and are handled by taking the
 * whole tied block: it is better to dilute the measured lift than to let the sort
 * order decide it.
 */
export function topDecileLift(points: readonly ScoredPoint[]): number {
  if (points.length === 0) return 0;
  const positives = points.filter((p) => p.label === "occurrence").length;
  if (positives === 0) return 0;

  const sorted = [...points].sort((a, b) => b.score - a.score);
  let cut = Math.max(1, Math.floor(sorted.length * 0.1));
  while (cut < sorted.length && sorted[cut].score === sorted[cut - 1].score) cut++;

  const hits = sorted.slice(0, cut).filter((p) => p.label === "occurrence").length;
  const baseRate = positives / points.length;
  return baseRate === 0 ? 0 : (hits / cut) / baseRate;
}

export function metricsFor(points: readonly ScoredPoint[]): ValidationMetrics {
  const occ = points.filter((p) => p.label === "occurrence").map((p) => p.score);
  const bg = points.filter((p) => p.label === "background").map((p) => p.score);
  const mOcc = median(occ);
  const mBg = median(bg);
  return {
    occurrenceCount: occ.length,
    backgroundCount: bg.length,
    medianOccurrence: round3(mOcc),
    medianBackground: round3(mBg),
    medianDifference: round3(mOcc - mBg),
    auc: round3(auc(occ, bg)),
    topDecileLift: round3(topDecileLift(points)),
    zeroScoreRate: round3(points.filter((p) => p.score === 0).length / Math.max(1, points.length)),
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** A report a person can read, for the script and for a failing test's message. */
export function formatRun(run: ValidationRun): string {
  const m = run.metrics;
  const verdict =
    m.auc >= 0.75 ? "useful" :
    m.auc >= 0.65 ? "weak but real" :
    m.auc >= 0.55 ? "barely better than chance" :
    "no better than chance";
  return [
    `${run.name}`,
    `  occurrences ${m.occurrenceCount}   background ${m.backgroundCount}`,
    `  median score   occurrence ${m.medianOccurrence}   background ${m.medianBackground}   diff ${m.medianDifference}`,
    `  AUC            ${m.auc}   (${verdict})`,
    `  top-decile lift ${m.topDecileLift}x`,
    `  scored zero    ${Math.round(m.zeroScoreRate * 100)}% of all points`,
  ].join("\n");
}

// ── Leakage ─────────────────────────────────────────────────────────────────

/**
 * Does a layer's mere PRESENCE predict a known occurrence?
 *
 * WHY THIS EXISTS. The DEM was sampled in a k-ring around each MRDS site, so all
 * 2,191 terrain cells sit within 6.1 km of a known occurrence. Wiring terrain into
 * the score would therefore have raised every validation number — while teaching
 * the model nothing except "somebody sampled the DEM here", which they only did
 * next to occurrences. Textbook target leakage, and it would have looked exactly
 * like success.
 *
 * The harness caught it once. This makes it impossible to miss again: any layer
 * whose coverage tracks occurrence proximity is named before it can be trusted.
 */
export interface RoleLeakage {
  role: EvidenceRole;
  /** Fraction of OCCURRENCE points where this role produced evidence. */
  atOccurrences: number;
  /** Fraction of BACKGROUND points where it did. */
  atBackground: number;
  /**
   * atOccurrences / atBackground. 1.0 is unbiased. Infinity means the layer
   * exists ONLY where occurrences are, which is the worst case and the one that
   * looks best in a naive validation.
   */
  ratio: number;
  leaks: boolean;
}

/**
 * A layer leaks when it is BOTH common at occurrences AND much rarer away from
 * them. Both halves are needed: a layer present everywhere has ratio 1 and is
 * fine, and a layer present nowhere is useless but not misleading.
 */
export const LEAKAGE_RATIO_LIMIT = 2.0;
const LEAKAGE_MIN_PREVALENCE = 0.25;

export function coverageBias(points: readonly ScoredPoint[]): RoleLeakage[] {
  const occ = points.filter((p) => p.label === "occurrence");
  const bg = points.filter((p) => p.label === "background");
  if (occ.length === 0 || bg.length === 0) return [];

  const roles = new Set<EvidenceRole>();
  for (const p of points) for (const r of p.roles ?? []) roles.add(r);

  const rateIn = (set: readonly ScoredPoint[], role: EvidenceRole) =>
    set.filter((p) => (p.roles ?? []).includes(role)).length / set.length;

  return [...roles].map((role) => {
    const atOccurrences = rateIn(occ, role);
    const atBackground = rateIn(bg, role);
    const ratio = atBackground === 0
      ? (atOccurrences > 0 ? Infinity : 1)
      : atOccurrences / atBackground;
    return {
      role,
      atOccurrences: round3(atOccurrences),
      atBackground: round3(atBackground),
      ratio: Number.isFinite(ratio) ? round3(ratio) : Infinity,
      leaks: atOccurrences >= LEAKAGE_MIN_PREVALENCE && ratio > LEAKAGE_RATIO_LIMIT,
    };
  }).sort((a, b) => (b.ratio === Infinity ? 1e9 : b.ratio) - (a.ratio === Infinity ? 1e9 : a.ratio));
}

export function formatLeakage(rows: readonly RoleLeakage[]): string {
  if (rows.length === 0) return "  (no roles produced evidence)";
  const rendered = rows.map((r) => {
    const ratio = r.ratio === Infinity ? "  inf" : r.ratio.toFixed(2).padStart(5);
    return `  ${r.leaks ? "LEAKS" : "  ok "}  ${r.role.padEnd(14)}` +
      ` occ ${r.atOccurrences.toFixed(2)}  bg ${r.atBackground.toFixed(2)}  ratio ${ratio}`;
  });
  return rendered.join(NEWLINE);
}

/** Kept as a constant so a line break can never be eaten by a codegen pass. */
const NEWLINE = String.fromCharCode(10);

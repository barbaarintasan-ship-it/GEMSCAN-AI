// Which extra photos, if any, are actually worth asking for.
//
// THE RULE: never ask for a photo that will not change the answer.
//
// Asking a geologist to walk back to an outcrop for a shot the analysis did not
// need is the fastest way to have them stop taking photos altogether. So this
// is deliberately conservative and DEDUCTIVE — it asks only for coverage the
// sample demonstrably lacks, and only while more coverage could still move the
// result. It never invents a request from a hunch.
//
// It reads the analysis OUTPUT and does not change it. The reasoning module,
// its prompt and the confidence maths are untouched: this decides what to do
// about a result, not what the result is.
import type { MediaRole } from "./enterpriseSamples";
import type { ShotNeed } from "../app/(app)/enterprise/field-camera";

/** Above this the identification is settled and nothing more is asked for. */
export const SUFFICIENT_CONFIDENCE = 0.75;

/** Never ask for more than this at once — a list of seven is a list nobody does. */
export const MAX_REQUESTS = 3;

export interface AnalysisSummary {
  /** 0..1, as the engine computed it. */
  overallConfidence: number | null;
  /** Roles the sample already carries. */
  roles: MediaRole[];
  /** Free text the report may carry about what is missing. Optional. */
  missingInformation?: string[] | null;
}

/**
 * The coverage each request buys, and the role that already satisfies it.
 *
 * Order is priority order: a close-up of the specimen surface does more for a
 * doubtful identification than a wide context shot, so it is asked for first.
 */
const REQUESTS: Array<{ need: ShotNeed; satisfiedBy: MediaRole[]; keywords: string[] }> = [
  { need: "closer", satisfiedBy: ["surface_closeup", "key_feature"], keywords: ["close", "detail", "resolution", "blur"] },
  { need: "fresh_surface", satisfiedBy: [], keywords: ["fresh", "broken", "weather", "patina", "unweathered"] },
  { need: "mineral_closeup", satisfiedBy: ["key_feature"], keywords: ["mineral", "grain", "crystal", "sulphide", "sulfide"] },
  { need: "vein_closeup", satisfiedBy: [], keywords: ["vein", "quartz"] },
  { need: "angle", satisfiedBy: [], keywords: ["angle", "orientation", "side", "another view"] },
  { need: "wider_context", satisfiedBy: ["context"], keywords: ["context", "setting", "outcrop", "surrounding", "wider"] },
  { need: "weathered", satisfiedBy: [], keywords: ["weathered", "alteration", "oxid", "gossan"] },
];

/**
 * What to ask for after an analysis.
 *
 * Returns an EMPTY list when the answer is good enough — which is the common
 * case and the whole point. A request only appears when the sample lacks the
 * coverage that would address it.
 */
export function shotNeedsFor(a: AnalysisSummary): ShotNeed[] {
  // Confident enough: the extra photo would not change the conclusion, so it is
  // not asked for. This is the branch that keeps the loop moving.
  if (a.overallConfidence != null && a.overallConfidence >= SUFFICIENT_CONFIDENCE) return [];

  const have = new Set(a.roles);
  const text = (a.missingInformation ?? []).join(" ").toLowerCase();

  // The report named no gaps. There is nothing to point at, so nothing is
  // requested — except on a sample so thin that one more close-up is the only
  // move with a real chance of helping. Enumerating every view the sample
  // happens to lack would be exactly the unnecessary asking this must not do.
  if (text.length === 0) return a.roles.length < 2 ? ["closer"] : [];

  const out: ShotNeed[] = [];
  for (const r of REQUESTS) {
    // Already covered by a photo on the sample: never ask twice for the same view.
    if (r.satisfiedBy.some((role) => have.has(role))) continue;
    // The report's own words decide. A request it did not raise is not invented
    // here on top of it.
    if (!r.keywords.some((k) => text.includes(k))) continue;
    out.push(r.need);
    if (out.length >= MAX_REQUESTS) break;
  }
  return out;
}

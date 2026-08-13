// GeoContext runtime — evidence fusion (Architecture §7/§9a).
//
// Merges provider contributions into one GeoContextData:
//   * ARRAY sections (formations, knownOccurrences, commodityAssociations,
//     historicalReports, faults, intrusions, lithology, hostRocks, *anomalies*,
//     alteration) are concatenated across providers.
//   * SCALAR sections (geology.*, metamorphism.*) are resolved by provider PRIORITY;
//     losing values are kept as `alternatives` (never silently dropped).
//   * communityEvidence is taken from whichever provider supplies it.
//   * All evidence is aggregated and turned into ranked reasoningFactors.

import { resolveConflict } from "./priority.ts";
import type { EvidenceItem, GeoContextData, ProviderContribution } from "./types.ts";

function uniqStrings(xs: string[]): string[] {
  return [...new Set(xs.filter((x) => x != null && x !== ""))];
}

/**
 * A fresh, empty result — CONSTRUCTED, not cloned.
 *
 * This was a module-level constant deep-copied with `structuredClone`, and that
 * broke the whole engine on a phone. Hermes — the JS engine React Native runs in
 * — has no `structuredClone`, so every call to `fuse` below threw
 * `ReferenceError: Property 'structuredClone' doesn't exist` before it did any
 * work. On the device that meant the offline GeoContext produced nothing at all,
 * over and over: the exploration screen calls this on a timer, so logcat showed
 * ninety-one unhandled rejections climbing at roughly one a second.
 *
 * It passed every test, because jest and deno both run on Node, and Node HAS
 * `structuredClone`. The bug lived exactly in the gap between the two engines.
 *
 * A factory is better than any clone here, not merely a workaround: the fresh
 * arrays are visible in the source, so no future reader has to reason about
 * whether a nested array is shared with the template. It cannot leak between
 * calls, which is the property the clone existed to provide.
 */
function emptyData(): GeoContextData {
  return {
    geology: {},
    formations: [],
    lithology: [],
    hostRocks: [],
    faults: [],
    intrusions: [],
    metamorphism: {},
    knownOccurrences: [],
    commodityAssociations: [],
    geochemistry: { anomalies: [] },
    geophysics: { anomalies: [] },
    remoteSensing: { alteration: [] },
    historicalReports: [],
    communityEvidence: {},
  };
}

export interface FusionResult {
  data: GeoContextData & { geologyAlternatives?: Record<string, unknown> };
  evidence: EvidenceItem[];
  reasoningFactors: string[];
}

export function fuse(contributions: ProviderContribution[]): FusionResult {
  const data: GeoContextData = emptyData();
  const evidence: EvidenceItem[] = [];

  // Array sections — concat across providers.
  for (const c of contributions) {
    const d = c.data;
    if (d.formations) data.formations.push(...d.formations);
    if (d.lithology) data.lithology.push(...d.lithology);
    if (d.hostRocks) data.hostRocks.push(...d.hostRocks);
    if (d.faults) data.faults.push(...d.faults);
    if (d.intrusions) data.intrusions.push(...d.intrusions);
    if (d.knownOccurrences) data.knownOccurrences.push(...d.knownOccurrences);
    if (d.commodityAssociations) data.commodityAssociations.push(...d.commodityAssociations);
    if (d.historicalReports) data.historicalReports.push(...d.historicalReports);
    if (d.geochemistry?.anomalies) data.geochemistry.anomalies.push(...d.geochemistry.anomalies);
    if (d.geophysics?.anomalies) data.geophysics.anomalies.push(...d.geophysics.anomalies);
    if (d.remoteSensing?.alteration) data.remoteSensing.alteration.push(...d.remoteSensing.alteration);
    if (d.communityEvidence) data.communityEvidence = { ...data.communityEvidence, ...d.communityEvidence };
    evidence.push(...c.evidence);
  }
  data.hostRocks = uniqStrings(data.hostRocks);

  // Scalar sections — resolve by priority, retain alternatives.
  const geologyAlternatives: Record<string, unknown> = {};
  for (const field of ["unit", "tectonicProvince", "structuralSetting"] as const) {
    const resolved = resolveConflict(
      contributions.map((c) => ({
        value: (c.data.geology?.[field] as string | undefined) ?? undefined,
        source: c.provider,
        priority: c.priority,
      })),
    );
    if (resolved) {
      (data.geology as Record<string, unknown>)[field] = resolved.value;
      if (resolved.alternatives.length) geologyAlternatives[field] = resolved.alternatives;
    }
  }
  for (const field of ["belt", "grade"] as const) {
    const resolved = resolveConflict(
      contributions.map((c) => ({
        value: (c.data.metamorphism?.[field] as string | undefined) ?? undefined,
        source: c.provider,
        priority: c.priority,
      })),
    );
    if (resolved) (data.metamorphism as Record<string, unknown>)[field] = resolved.value;
  }

  // reasoningFactors — evidence statements ranked by weight, deduped.
  const reasoningFactors = uniqStrings(
    [...evidence].sort((a, b) => b.weight - a.weight).map((e) => e.statement),
  );

  const out = geologyAlternatives && Object.keys(geologyAlternatives).length
    ? { ...data, geologyAlternatives }
    : data;
  return { data: out, evidence, reasoningFactors };
}

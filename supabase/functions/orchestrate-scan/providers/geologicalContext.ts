// Geological Context Engine.
//
// Only runs when the user supplied a (coarse, client-fuzzed) find location.
// Queries Macrostrat's free public API (https://macrostrat.org — CC BY, no
// key required; see §03 Tier 1 sourcing) for the geologic unit/lithology at
// that point, and maps common lithology terms to specimen types that are
// plausible finds there. This is intentionally a WEAK, low-weight vote: it
// has never seen the actual specimen, it only knows what's geologically
// common at that location, and it functions mainly as a locality-aware
// re-ranking signal in ensemble.ts rather than a primary identification.
//
// This is a small starter keyword table, not an exhaustive lithology→mineral
// mapping — expanding it is exactly the kind of thing the continuous
// improvement / living knowledge base (§03 §5) should grow over time.
import type { ProviderInput, ProviderResult, VisionProvider } from "./types.ts";
import { createAbstainResult } from "./promptShared.ts";

const LITHOLOGY_TO_CANDIDATES: Record<string, string[]> = {
  granite: ["quartz", "feldspar", "mica", "tourmaline"],
  basalt: ["olivine", "pyroxene", "zeolite", "agate"],
  kimberlite: ["diamond", "garnet", "olivine"],
  limestone: ["calcite", "fossil coral", "dolomite"],
  shale: ["pyrite", "fossil impression"],
  sandstone: ["quartz", "iron oxide concretion"],
  schist: ["garnet", "mica", "staurolite"],
  pegmatite: ["tourmaline", "beryl", "quartz", "feldspar"],
  volcanic: ["obsidian", "pumice", "zeolite"],
  placer: ["gold", "native copper"],
};

export const geologicalContextProvider: VisionProvider = {
  name: "geological_context",
  // Low weight by design — see header comment. Acts more as a re-ranker
  // (applied separately in ensemble.ts) than a primary voter.
  baseWeight: 0.08,
  isApplicable: (input) => input.location !== null,

  async identify(input: ProviderInput): Promise<ProviderResult> {
    const start = Date.now();
    if (!input.location) {
      return createAbstainResult("geological_context", start, "No location supplied");
    }

    try {
      const res = await fetch(
        `https://macrostrat.org/api/v2/geologic_units/map?lat=${input.location.lat}&lng=${input.location.lng}&format=json`,
      );
      const raw = await res.json();
      if (!res.ok) {
        throw new Error(`Macrostrat API error (status ${res.status})`);
      }

      const units: { lith?: string; name?: string }[] = raw?.success?.data ?? [];
      const candidateCounts = new Map<string, number>();

      for (const unit of units) {
        const lith = (unit.lith ?? "").toLowerCase();
        for (const [keyword, candidates] of Object.entries(LITHOLOGY_TO_CANDIDATES)) {
          if (lith.includes(keyword)) {
            for (const candidate of candidates) {
              candidateCounts.set(candidate, (candidateCounts.get(candidate) ?? 0) + 1);
            }
          }
        }
      }

      if (candidateCounts.size === 0) {
        return {
          provider: "geological_context",
          candidate: null,
          alternatives: [],
          reasoning:
            "Could not map the local geologic unit to any known specimen types in the reference table.",
          latencyMs: Date.now() - start,
          raw,
        };
      }

      const ranked = [...candidateCounts.entries()].sort((a, b) => b[1] - a[1]);
      const maxCount = ranked[0][1];
      const [bestLabel] = ranked[0];

      return {
        provider: "geological_context",
        candidate: { label: bestLabel, confidence: Math.min(0.5, 0.2 + 0.1 * maxCount) },
        alternatives: ranked
          .slice(1, 5)
          .map(([label, count]) => ({ label, confidence: Math.min(0.4, 0.15 + 0.1 * count) })),
        reasoning: `Locally mapped geologic units suggest specimens commonly found in this area: ${ranked
          .slice(0, 5)
          .map(([l]) => l)
          .join(", ")}.`,
        latencyMs: Date.now() - start,
        raw,
      };
    } catch (err) {
      return createAbstainResult("geological_context", start, (err as Error).message);
    }
  },
};

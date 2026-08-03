// Shadow-mode divergence detection (Stage E3).
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { compareContexts, summarise, formatReport, DEFAULT_TOLERANCES } from "./divergence.ts";
import type { GeoContext } from "../types.ts";

function ctx(over: Partial<GeoContext> = {}): GeoContext {
  const base = {
    location: { lat: 2.0469, lng: 45.3182, h3: "87abc" },
    geology: { unit: "Precambrian Basement" },
    formations: [], lithology: [], hostRocks: [], faults: [], intrusions: [],
    metamorphism: {},
    knownOccurrences: [
      { commodity: "gold", depositType: "orogenic", source: "USGS MRDS", reference: "M1", distanceM: 400 },
    ],
    commodityAssociations: [],
    geochemistry: { anomalies: [] },
    geophysics: { anomalies: [] },
    remoteSensing: { alteration: [] },
    historicalReports: [],
    communityEvidence: {},
    reasoningFactors: [],
    evidence: { providers: [], datasets: [{ source: "USGS MRDS", version: "2024" }] },
    confidence: { overall: "Moderate" as const, score: 0.5, byProvider: {}, factors: [] },
    meta: {
      engineVersion: "1.0.0", generatedAt: "2026-08-03T00:00:00.000Z",
      providersRun: ["geology", "occurrence"], providersFailed: [], cache: "miss" as const,
    },
  };
  return { ...base, ...over } as GeoContext;
}

Deno.test("identical contexts match", () => {
  const r = compareContexts(ctx(), ctx());
  assertEquals(r.ok, true);
  assertEquals(r.divergences.length, 0);
  assertEquals(formatReport(r).startsWith("MATCH"), true);
});

Deno.test("a distance within 0.5% is tolerated — this is the expected geodesy case", () => {
  // 400 m vs 401.6 m = 0.4%, inside tolerance.
  const device = ctx({
    knownOccurrences: [
      { commodity: "gold", depositType: "orogenic", source: "USGS MRDS", reference: "M1", distanceM: 401.6 },
    ],
  });
  assertEquals(compareContexts(device, ctx()).ok, true);
});

Deno.test("a distance beyond 0.5% is reported", () => {
  const device = ctx({
    knownOccurrences: [
      { commodity: "gold", depositType: "orogenic", source: "USGS MRDS", reference: "M1", distanceM: 420 },
    ],
  });
  const r = compareContexts(device, ctx());
  assertEquals(r.ok, false);
  assertEquals(r.divergences[0].kind, "occurrence-distance");
  assertEquals(r.divergences[0].exact, false); // a tolerance breach, not a rule breach
});

Deno.test("a differing evidence SET is zero-tolerance, however close the distances", () => {
  // The ST_DWithin boundary case: one side included an occurrence, the other did not.
  const device = ctx({ knownOccurrences: [] });
  const r = compareContexts(device, ctx());
  assertEquals(r.ok, false);
  const d = r.divergences.find((x) => x.kind === "evidence-membership")!;
  assertEquals(d.exact, true);
  assertEquals(d.detail?.includes("only-server"), true);
});

Deno.test("a differing geology unit is zero-tolerance", () => {
  const r = compareContexts(ctx({ geology: { unit: "Coastal Sands" } }), ctx());
  assertEquals(r.divergences.some((d) => d.kind === "geology-unit" && d.exact), true);
});

Deno.test("provider ORDER matters, not just membership", () => {
  const device = ctx({
    meta: { ...ctx().meta, providersRun: ["occurrence", "geology"] },
  });
  const r = compareContexts(device, ctx());
  assertEquals(r.divergences.some((d) => d.kind === "provider-order"), true);
});

Deno.test("a provider failing on one side only is reported", () => {
  const device = ctx({ meta: { ...ctx().meta, providersFailed: ["community"] } });
  assertEquals(compareContexts(device, ctx()).divergences.some((d) => d.kind === "provider-failed"), true);
});

Deno.test("confidence within 0.01 is tolerated, beyond it is reported", () => {
  const near = ctx({ confidence: { overall: "Moderate", score: 0.505, byProvider: {}, factors: [] } });
  assertEquals(compareContexts(near, ctx()).ok, true);

  const far = ctx({ confidence: { overall: "Moderate", score: 0.55, byProvider: {}, factors: [] } });
  assertEquals(compareContexts(far, ctx()).divergences.some((d) => d.kind === "confidence-score"), true);
});

Deno.test("a band change is reported even when the score delta is tiny", () => {
  // 0.665 vs 0.67 straddles the Moderate/High boundary: user-visible.
  const device = ctx({ confidence: { overall: "Moderate", score: 0.665, byProvider: {}, factors: [] } });
  const server = ctx({ confidence: { overall: "High", score: 0.67, byProvider: {}, factors: [] } });
  const r = compareContexts(device, server);
  assertEquals(r.divergences.some((d) => d.kind === "confidence-band" && d.exact), true);
  // The score itself is inside tolerance — the band is what catches it.
  assertEquals(r.divergences.some((d) => d.kind === "confidence-score"), false);
});

Deno.test("a differing dataset set is reported", () => {
  const device = ctx({ evidence: { providers: [], datasets: [{ source: "Other", version: "1" }] } });
  assertEquals(compareContexts(device, ctx()).divergences.some((d) => d.kind === "dataset-set"), true);
});

Deno.test("all disagreements are returned, not just the first", () => {
  const device = ctx({
    geology: { unit: "Wrong" },
    confidence: { overall: "High", score: 0.9, byProvider: {}, factors: [] },
  });
  const r = compareContexts(device, ctx());
  assertEquals(r.divergences.length >= 3, true); // unit + score + band
});

Deno.test("a sub-metre difference is not a divergence, however large the percentage", () => {
  const at0 = ctx({
    knownOccurrences: [
      { commodity: "gold", depositType: "orogenic", source: "USGS MRDS", reference: "M1", distanceM: 0 },
    ],
  });
  const device = ctx({
    knownOccurrences: [
      { commodity: "gold", depositType: "orogenic", source: "USGS MRDS", reference: "M1", distanceM: 0.2 },
    ],
  });
  // 0.2 m at ~0 m is 20% relative — but 0.2 m is geologically meaningless, and
  // the absolute floor is what stops a shadow run drowning in noise.
  assertEquals(compareContexts(device, at0).ok, true);

  // A metres-scale difference at short range IS still caught.
  const wayOff = ctx({
    knownOccurrences: [
      { commodity: "gold", depositType: "orogenic", source: "USGS MRDS", reference: "M1", distanceM: 25 },
    ],
  });
  assertEquals(compareContexts(wayOff, at0).ok, false);
});

Deno.test("summarise aggregates a run and counts exact breaches separately", () => {
  const reports = [
    compareContexts(ctx(), ctx()),
    compareContexts(ctx({ geology: { unit: "Wrong" } }), ctx()),
    compareContexts(
      ctx({
        knownOccurrences: [
          { commodity: "gold", depositType: "orogenic", source: "USGS MRDS", reference: "M1", distanceM: 500 },
        ],
      }),
      ctx(),
    ),
  ];
  const s = summarise(reports);
  assertEquals(s.total, 3);
  assertEquals(s.matched, 1);
  assertEquals(s.byKind["geology-unit"], 1);
  assertEquals(s.byKind["occurrence-distance"], 1);
  assertEquals(s.exactBreaches, 1); // only the geology-unit one
});

Deno.test("tolerances are configurable for a stricter run", () => {
  const device = ctx({
    knownOccurrences: [
      { commodity: "gold", depositType: "orogenic", source: "USGS MRDS", reference: "M1", distanceM: 401 },
    ],
  });
  assertEquals(compareContexts(device, ctx()).ok, true);
  assertEquals(
    compareContexts(device, ctx(), { ...DEFAULT_TOLERANCES, distanceRelative: 0.0001, distanceFloorM: 0.1 }).ok,
    false,
  );
});

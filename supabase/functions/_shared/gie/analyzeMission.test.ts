// analyzeExplorationPackage, and renderReport, end to end with a fake model.
//
//   deno test --allow-net=deno.land supabase/functions/_shared/gie/analyzeMission.test.ts
//
// These are the seven cases asked for, plus the two that matter most and are
// easiest to skip: analysis must not begin before the photographs are confirmed in
// storage, and an AI failure must never cost a geologist their evidence.
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  analyzeExplorationPackage, type AIProvider, type AnalyzeInput,
} from "./analyzeMission.ts";
import type { EnginePackageSummary } from "./missionPrompt.ts";
import { findForbiddenLanguage } from "../../../../shared/geo-core/gie/missionFindings.ts";
import { renderingsAgree, renderReport } from "../../../../shared/geo-core/gie/renderReport.ts";

const R2 = {
  accountId: "acct", accessKeyId: "id", secretAccessKey: "secret", bucket: "bucket",
};
const NOW = Date.parse("2026-08-10T00:00:00.000Z");

function engine(over: Partial<EnginePackageSummary> = {}): EnginePackageSummary {
  return {
    missionId: "ms-abc", commodity: "gold", prospectivityScore: 0.62,
    targetCell: "877a1c723ffffff", lat: 9.5624, lng: 44.0651, gpsAccuracyM: 8,
    lithology: "Precambrian Basement", terrainMorphology: "valley", elevationM: 706,
    faultDistanceM: 340, contactDistanceM: null, drainageDistanceM: 1200,
    coverage: [
      { role: "geology", status: "present" },
      { role: "terrain", status: "present" },
      { role: "geochemistry", status: "no_source" },
    ],
    engineReasons: ["fault 340 m away"],
    observations: [{ type: "quartz-vein", notes: "40 cm vein", positionQuality: "good", photoCount: 1 }],
    photoCount: 1, trackPoints: 148,
    ...over,
  };
}

function input(over: Partial<AnalyzeInput> = {}): AnalyzeInput {
  return {
    engine: engine(),
    payload: { missionId: "ms-abc", observations: [{ photos: [{ id: "p1" }] }] },
    ...over,
  };
}

const GOOD_RESPONSE = JSON.stringify({
  interest: "moderate",
  confidence: "medium",
  evidence: [
    {
      type: "quartz_vein", origin: "field_observation", status: "present",
      strength: "moderate", confidence: "medium", significance: "hydrothermal_indicator",
    },
    {
      type: "fault_proximity", origin: "engine_layer", status: "present",
      strength: "moderate", confidence: "medium", significance: "fluid_pathway", value: 340,
    },
    {
      type: "geochemistry", origin: "engine_layer", status: "no_source",
      strength: "absent", confidence: "low", significance: "not_available",
    },
  ],
  missing_evidence: ["assay", "geochemistry", "alteration_mapping"],
  recommendations: [
    { action: "collect_rock_samples", priority: 1, because_of: ["quartz_vein"] },
    { action: "submit_for_assay", priority: 2, because_of: ["quartz_vein"] },
  ],
  narrative: {
    en: {
      summary: "Field evidence indicates a geologically interesting zone with quartz vein " +
        "observations and favourable structural context. No assay exists.",
      interpretation: "The vein sits 340 m from a mapped fault in metamorphic basement.",
    },
    so: {
      summary: "Caddeymaha goobta waxay tilmaamayaan aag xiiso leh, oo lagu arkay xidid " +
        "quartz ah (quartz vein). Assay ma jirto.",
      interpretation: "Xididku wuxuu 340 m u jiraa jeex (fault) oo basement metamorphic ah.",
    },
  },
});

function provider(text: string | (() => Promise<string>)): AIProvider {
  return {
    model: "test-model",
    generate: typeof text === "string" ? async () => text : text,
  };
}

/** Every named key is present, at a plausible size. */
const allPresent = async (_c: unknown, keys: readonly string[]) =>
  keys.map((key) => ({ key, exists: true, bytes: 2_400_000, status: 200 }));

Deno.test("1. a complete package produces a report", async () => {
  const out = await analyzeExplorationPackage(input(), {
    provider: provider(GOOD_RESPONSE), r2: R2, verify: allPresent, now: () => NOW,
  });
  assertEquals(out.status, "analysed");
  if (out.status !== "analysed") return;
  assertEquals(out.findings.interest, "moderate");
  assertEquals(out.findings.evidence.length, 3);
  assertEquals(out.findings.missingEvidence.length, 3);
  assertEquals(out.findings.model, "test-model");
  assertEquals(out.verification!.complete, true);
  assertEquals(out.violations, []);
});

Deno.test("2. MISSING PHOTOS BLOCK THE ANALYSIS", async () => {
  // A model given nine of ten photographs writes a report that reads exactly like
  // a complete one. So the bytes are confirmed first, or nothing happens.
  let asked = false;
  const out = await analyzeExplorationPackage(input(), {
    provider: provider(async () => { asked = true; return GOOD_RESPONSE; }),
    r2: R2,
    verify: async (_c, keys) => keys.map((key) => ({ key, exists: false, bytes: null, status: 404 })),
    now: () => NOW,
  });
  assertEquals(out.status, "blocked");
  if (out.status !== "blocked") return;
  assertEquals(out.reason, "photos_not_in_storage");
  assertEquals(out.verification.missing.length, 1);
  // The model was never called — this is a gate, not a warning.
  assertEquals(asked, false);
});

Deno.test("2b. a zero-byte object blocks it too", async () => {
  const out = await analyzeExplorationPackage(input(), {
    provider: provider(GOOD_RESPONSE), r2: R2, now: () => NOW,
    verify: async (_c, keys) => keys.map((key) => ({ key, exists: true, bytes: 0, status: 200 })),
  });
  assertEquals(out.status, "blocked");
});

Deno.test("2c. unreachable storage is FAILED, not blocked — 'cannot tell' is not 'missing'", async () => {
  // Blocking would be a verdict on the evidence. Failing is a verdict on the
  // network, and only one of those is true here.
  const out = await analyzeExplorationPackage(input(), {
    provider: provider(GOOD_RESPONSE), r2: R2, now: () => NOW,
    verify: async () => { throw new Error("network down"); },
  });
  assertEquals(out.status, "failed");
  if (out.status !== "failed") return;
  assertStringIncludes(out.detail, "verification unreachable");
});

Deno.test("2d. photographs with no storage configured are REFUSED, not waved through", async () => {
  const out = await analyzeExplorationPackage(input(), {
    provider: provider(GOOD_RESPONSE), now: () => NOW,
  });
  assertEquals(out.status, "refused");
  if (out.status !== "refused") return;
  assertEquals(out.reason, "storage_not_configured");
});

Deno.test("3. a mission collected offline analyses fine once synced", async () => {
  // Nothing in the analysis path cares when the evidence was collected — only that
  // it is now in storage. A week-old package with an old timestamp is ordinary.
  const old = input({
    engine: engine({ missionId: "ms-old" }),
    payload: { missionId: "ms-old", observations: [{ photos: [{ id: "p9" }] }] },
  });
  const out = await analyzeExplorationPackage(old, {
    provider: provider(GOOD_RESPONSE), r2: R2, verify: allPresent, now: () => NOW,
  });
  assertEquals(out.status, "analysed");
});

Deno.test("4. no commodity selected gives a universal analysis", async () => {
  const out = await analyzeExplorationPackage(
    input({ engine: engine({ commodity: null }) }),
    { provider: provider(GOOD_RESPONSE), r2: R2, verify: allPresent, now: () => NOW },
  );
  assertEquals(out.status, "analysed");
  if (out.status !== "analysed") return;
  // The commodity comes from the ENGINE, never from the model's answer — a model
  // cannot decide it was assessing gold.
  assertEquals(out.findings.commodity, null);
});

Deno.test("5. NO PROBABILITY LANGUAGE SURVIVES, in either language", async () => {
  const bad = JSON.parse(GOOD_RESPONSE);
  bad.narrative.en.summary = "There is a 70% chance of gold at this site.";
  bad.narrative.so.summary = "Suurtagalnimada dahabku waa boqolkiiba 70.";
  const out = await analyzeExplorationPackage(input(), {
    provider: provider(JSON.stringify(bad)), r2: R2, verify: allPresent, now: () => NOW,
  });
  assertEquals(out.status, "analysed");
  if (out.status !== "analysed") return;
  // The prose is gone, the assessment survives, and the violations are recorded.
  assertEquals(out.findings.narrative, undefined);
  assertEquals(out.violations.length >= 2, true);
  assertEquals(findForbiddenLanguage(out.findings), []);
  assertEquals(out.findings.evidence.length, 3);
  assertEquals(out.findings.recommendations.length, 2);
});

Deno.test("5b. a returned score is discarded — the engine keeps its number", async () => {
  const bad = JSON.parse(GOOD_RESPONSE);
  bad.prospectivity_score = 0.95;
  const out = await analyzeExplorationPackage(input(), {
    provider: provider(JSON.stringify(bad)), r2: R2, verify: allPresent, now: () => NOW,
  });
  assertEquals(out.status, "analysed");
  if (out.status !== "analysed") return;
  assertEquals(JSON.stringify(out.findings).includes("0.95"), false);
  assertEquals(out.discarded.some((d) => d.includes("the engine owns the score")), true);
});

Deno.test("6. missing evidence is reported honestly, and confidence is capped", async () => {
  const optimistic = JSON.parse(GOOD_RESPONSE);
  optimistic.confidence = "high";
  const out = await analyzeExplorationPackage(input(), {
    provider: provider(JSON.stringify(optimistic)), r2: R2, verify: allPresent, now: () => NOW,
  });
  assertEquals(out.status, "analysed");
  if (out.status !== "analysed") return;
  // Two present layers, no assay, no geochemistry. HIGH is not available.
  assertEquals(out.findings.confidence, "low");
  assertEquals(out.findings.missingEvidence.includes("assay"), true);
  assertEquals(out.findings.missingEvidence.includes("geochemistry"), true);
});

Deno.test("7. AI FAILURE DOES NOT DESTROY MISSION DATA", async () => {
  // Every outcome is a value. The package is never mutated here, so a failed
  // analysis leaves a geologist's evidence exactly as it was, ready to retry.
  const pkg = input();
  const frozen = JSON.stringify(pkg);

  for (const [name, p] of [
    ["provider throws", provider(async () => { throw new Error("model 503"); })],
    ["not JSON", provider("the rock looks interesting")],
    ["empty analysis", provider(JSON.stringify({ interest: "none", evidence: [], missing_evidence: [] }))],
  ] as Array<[string, AIProvider]>) {
    const out = await analyzeExplorationPackage(pkg, {
      provider: p, r2: R2, verify: allPresent, now: () => NOW,
    });
    assertEquals(out.status, "failed", name);
    // Untouched.
    assertEquals(JSON.stringify(pkg), frozen, name);
  }
});

// ── The report, rendered ────────────────────────────────────────────────────

/** A translator that has entries for everything except two codes, on purpose. */
function translator(lang: "en" | "so"): (k: string, p?: Record<string, string | number>) => string {
  const dict: Record<string, string> = {
    "report.section.overview": lang === "en" ? "OVERVIEW" : "GUUD AHAAN",
    "report.section.observations": lang === "en" ? "FIELD OBSERVATIONS" : "INDHO-INDHEYN",
    "report.section.visual": lang === "en" ? "VISUAL EVIDENCE" : "CADDAYN SAWIR AH",
    "report.section.context": lang === "en" ? "GEOLOGICAL CONTEXT" : "XAALADDA JUQRAAFI",
    "report.section.interpretation": lang === "en" ? "INTERPRETATION" : "FASIRAAD",
    "report.section.missing": lang === "en" ? "EVIDENCE MISSING" : "CADDEYMO MAQAN",
    "report.section.actions": lang === "en" ? "NEXT STEPS" : "TALLAABOOYIN XIGA",
    "report.section.confidence": lang === "en" ? "CONFIDENCE" : "KALSOONI",
    "report.score.value": "score {{score}}",
    "report.score.notAProbability": lang === "en"
      ? "A ranking, not a probability of discovery."
      : "Kala-horreysiin, ee ma aha suurtogalnimada helitaanka.",
    "report.score.commodity": "for {{commodity}}",
    "report.score.universal": "universal",
    "commodity.gold": lang === "en" ? "Gold" : "Dahab",
    "report.evidence.row": "{{name}} — {{status}} · {{strength}} · {{reason}}",
    "report.evidence.none": "none",
    "report.missing.none": "none",
    "report.action.row": "{{n}}. {{action}}",
    "report.action.none": "none",
    "report.confidence.value": "{{confidence}}",
    "report.confidence.meaning": lang === "en"
      ? "How complete the evidence is — not a likelihood of a deposit."
      : "Sida caddeymuhu u dhammaystiran yihiin — ee ma aha suurtogalnimada macdan.",
    "report.confidence.capped": "reduced from {{claimed}}",
    "report.confidence.low": lang === "en" ? "LOW" : "HOOSE",
    "report.confidence.medium": lang === "en" ? "MEDIUM" : "DHEXDHEXAAD",
    "report.confidence.high": lang === "en" ? "HIGH" : "SARE",
    "report.interest.moderate": lang === "en" ? "moderate" : "dhexdhexaad",
    "report.strength.moderate": lang === "en" ? "moderate" : "dhexdhexaad",
    "report.strength.absent": lang === "en" ? "absent" : "maqan",
    "field.coverage.present": lang === "en" ? "Used" : "La isticmaalay",
    "field.coverage.no_source": lang === "en" ? "No data source" : "Il xog ma laha",
    "report.evidenceType.quartz_vein": lang === "en" ? "Quartz vein" : "Xidid quartz",
    "report.evidenceType.fault_proximity": lang === "en" ? "Near a fault" : "Jeex u dhow",
    "report.evidenceType.geochemistry": lang === "en" ? "Geochemistry" : "Geochemistry",
    "report.significance.hydrothermal_indicator": lang === "en"
      ? "may occur in hydrothermal systems; needs geochemical confirmation"
      : "wuxuu ka dhici karaa nidaamyada hydrothermal; wuxuu u baahan yahay xaqiijin",
    "report.significance.fluid_pathway": lang === "en" ? "a possible fluid pathway" : "waddo dareere",
    "report.missing.assay": lang === "en" ? "No assay result" : "Natiijo assay ma jirto",
    "report.missing.geochemistry": lang === "en" ? "No geochemistry" : "Geochemistry ma jirto",
    "report.action.collect_rock_samples": lang === "en"
      ? "Collect representative rock samples" : "Ururi muunado dhagax matalaya",
    "report.action.submit_for_assay": lang === "en" ? "Submit samples for assay" : "U dir muunadaha assay",
    // DELIBERATELY ABSENT: report.significance.not_available,
    // report.missing.alteration_mapping — to prove an unknown code never renders blank.
  };
  return (k, p) => {
    let s = dict[k];
    if (s == null) return k;
    for (const [key, val] of Object.entries(p ?? {})) s = s.replace(`{{${key}}}`, String(val));
    return s;
  };
}

Deno.test("the report renders the six sections, in both languages", async () => {
  const out = await analyzeExplorationPackage(input(), {
    provider: provider(GOOD_RESPONSE), r2: R2, verify: allPresent, now: () => NOW,
  });
  if (out.status !== "analysed") throw new Error("expected analysed");

  const en = renderReport(out.findings, translator("en"), "en", { prospectivityScore: 0.62 });
  const so = renderReport(out.findings, translator("so"), "so", { prospectivityScore: 0.62 });

  // The six sections of a field report. `evidence` used to be one flat list;
  // it is now split by ORIGIN, because a geologist's own observation and a layer
  // read off a map are not the same kind of claim.
  const titles = en.sections.map((s) => s.titleKey);
  assertEquals(titles.includes("report.section.overview"), true);
  assertEquals(titles.includes("report.section.observations"), true);
  assertEquals(titles.includes("report.section.visual"), true);
  assertEquals(titles.includes("report.section.context"), true);
  assertEquals(titles.includes("report.section.missing"), true);
  assertEquals(titles.includes("report.section.actions"), true);
  assertEquals(titles.includes("report.section.confidence"), true);

  // The Somali is Somali, and it is not the English.
  assertStringIncludes(so.sections[0].title, "GUUD AHAAN");
  assertStringIncludes(en.sections[0].title, "OVERVIEW");
  assertEquals(en.sections[0].lines[0] === so.sections[0].lines[0], false);
});

Deno.test("THE BILINGUAL GUARANTEE: the two renderings agree on the geology", async () => {
  const out = await analyzeExplorationPackage(input(), {
    provider: provider(GOOD_RESPONSE), r2: R2, verify: allPresent, now: () => NOW,
  });
  if (out.status !== "analysed") throw new Error("expected analysed");
  const en = renderReport(out.findings, translator("en"), "en", { prospectivityScore: 0.62 });
  const so = renderReport(out.findings, translator("so"), "so", { prospectivityScore: 0.62 });

  // Same confidence, same interest, same shape — structurally, because both are
  // rendered from one set of codes. This is the requirement that switching
  // language cannot change the conclusion.
  assertEquals(renderingsAgree(en, so), true);
  assertEquals(en.confidence, so.confidence);
  assertEquals(en.interest, so.interest);
});

Deno.test("switching language needs NO model call", async () => {
  let calls = 0;
  const out = await analyzeExplorationPackage(input(), {
    provider: { model: "test-model", generate: async () => { calls++; return GOOD_RESPONSE; } },
    r2: R2, verify: allPresent, now: () => NOW,
  });
  if (out.status !== "analysed") throw new Error("expected analysed");
  assertEquals(calls, 1);
  renderReport(out.findings, translator("en"), "en", { prospectivityScore: 0.62 });
  renderReport(out.findings, translator("so"), "so", { prospectivityScore: 0.62 });
  renderReport(out.findings, translator("en"), "en", { prospectivityScore: 0.62 });
  // Three renders, still one analysis.
  assertEquals(calls, 1);
});

Deno.test("an untranslated code is humanised and REPORTED, never blank", async () => {
  const out = await analyzeExplorationPackage(input(), {
    provider: provider(GOOD_RESPONSE), r2: R2, verify: allPresent, now: () => NOW,
  });
  if (out.status !== "analysed") throw new Error("expected analysed");
  const so = renderReport(out.findings, translator("so"), "so", { prospectivityScore: 0.62 });

  // The two codes the fixture translator deliberately lacks.
  assertEquals(so.untranslated.includes("not_available"), true);
  assertEquals(so.untranslated.includes("alteration_mapping"), true);
  // And nothing rendered empty, nor as a raw code with underscores.
  for (const s of so.sections) {
    for (const line of s.lines) {
      assertEquals(line.trim().length > 0, true);
      assertEquals(/[a-z]_[a-z]/.test(line), false, `raw code leaked: ${line}`);
    }
  }
});

Deno.test("the score shown comes from the ENGINE, not the analysis", async () => {
  const out = await analyzeExplorationPackage(input(), {
    provider: provider(GOOD_RESPONSE), r2: R2, verify: allPresent, now: () => NOW,
  });
  if (out.status !== "analysed") throw new Error("expected analysed");
  const r = renderReport(out.findings, translator("en"), "en", { prospectivityScore: 0.62 });
  // The engine's ranking lives in Overview now, alongside what was investigated.
  const overview = r.sections.find((s) => s.titleKey === "report.section.overview")!;
  const text = overview.lines.join(" ");
  assertStringIncludes(text, "0.62");
  assertStringIncludes(text, "not a probability");
});

Deno.test("the report is complete with NO prose at all", async () => {
  // The narrative is a convenience. Strip it and every section a geologist needs
  // is still there, because they are all rendered from codes.
  const noProse = JSON.parse(GOOD_RESPONSE);
  delete noProse.narrative;
  const out = await analyzeExplorationPackage(input(), {
    provider: provider(JSON.stringify(noProse)), r2: R2, verify: allPresent, now: () => NOW,
  });
  if (out.status !== "analysed") throw new Error("expected analysed");
  assertEquals(out.findings.narrative, undefined);

  const r = renderReport(out.findings, translator("en"), "en", { prospectivityScore: 0.62 });
  for (const s of r.sections) assertEquals(s.lines.length > 0, true);
  // Evidence is three sections now, split by origin. Every one of them is
  // present with prose stripped, because they are all rendered from codes.
  assertEquals(r.sections.some((s) => s.titleKey === "report.section.observations"), true);
  assertEquals(r.sections.some((s) => s.titleKey === "report.section.visual"), true);
  assertEquals(r.sections.some((s) => s.titleKey === "report.section.context"), true);
  assertEquals(r.sections.some((s) => s.titleKey === "report.section.missing"), true);
});

Deno.test("a capped confidence says so in the report", async () => {
  const optimistic = JSON.parse(GOOD_RESPONSE);
  optimistic.confidence = "high";
  const out = await analyzeExplorationPackage(input(), {
    provider: provider(JSON.stringify(optimistic)), r2: R2, verify: allPresent, now: () => NOW,
  });
  if (out.status !== "analysed") throw new Error("expected analysed");
  const r = renderReport(out.findings, translator("en"), "en", { prospectivityScore: 0.62 });
  const conf = r.sections.find((s) => s.titleKey === "report.section.confidence")!;
  // The reader is told the model claimed more than the evidence supports.
  assertEquals(conf.lines.some((l) => l.includes("reduced from")), true);
});

// The prompt, and the parser's refusals.
//
//   deno test --allow-net=deno.land supabase/functions/_shared/gie/missionPrompt.test.ts
//
// The boundary being defended: the prospectivity engine's score goes in as a fact
// and never comes back out. The engine is validated — LOO AUC 0.900, BLIND 0.843 —
// and an interpretation layer able to adjust that number would replace a measured
// model with an unmeasured opinion, invisibly.
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildMissionPrompt, parseMissionFindings, type EnginePackageSummary } from "./missionPrompt.ts";
import { findForbiddenLanguage } from "../../../../shared/geo-core/gie/missionFindings.ts";

const META = { model: "test-model", commodity: "gold", analysedAt: 1_760_000_000_000 };

function summary(over: Partial<EnginePackageSummary> = {}): EnginePackageSummary {
  return {
    missionId: "ms-abc", commodity: "gold", prospectivityScore: 0.62,
    targetCell: "877a1c723ffffff", lat: 9.5624, lng: 44.0651, gpsAccuracyM: 8,
    lithology: "Precambrian Basement", terrainMorphology: "valley", elevationM: 706,
    faultDistanceM: 340, contactDistanceM: null, drainageDistanceM: 1200,
    coverage: [
      { role: "geology", status: "present" },
      { role: "terrain", status: "present" },
      { role: "contacts", status: "not_scored" },
      { role: "drainage", status: "not_scored" },
      { role: "lineaments", status: "empty_layer" },
      { role: "geochemistry", status: "no_source" },
      { role: "geophysics", status: "no_source" },
      { role: "remote_sensing", status: "no_source" },
    ],
    engineReasons: ["fault 340 m away", "mapped as valley"],
    observations: [
      { type: "quartz-vein", notes: "40 cm vein, limonite staining", positionQuality: "good", photoCount: 2 },
    ],
    photoCount: 2, trackPoints: 148,
    ...over,
  };
}

Deno.test("the prompt hands the engine's score over as a FACT, not a question", () => {
  const p = buildMissionPrompt(summary());
  assertStringIncludes(p, "0.62");
  assertStringIncludes(p, "a RANKING not a probability");
  assertStringIncludes(p, "NEVER recompute or contradict the prospectivity score");
  assertStringIncludes(p, "Do not output a score of your own");
  assertStringIncludes(p, "INTERPRETATION layer above a validated");
});

Deno.test("the prompt forbids odds in BOTH languages, by example", () => {
  const p = buildMissionPrompt(summary());
  assertStringIncludes(p, "70% chance");
  assertStringIncludes(p, "boqolkiiba 70");
  assertStringIncludes(p, "confirmed, guaranteed, certain or definite");
});

Deno.test("every evidence layer's status reaches the model, with what it means", () => {
  const p = buildMissionPrompt(summary());
  // The distinction the whole report rests on: not measured is not the same as
  // measured and absent.
  assertStringIncludes(p, "no_source   = this data does not exist anywhere in the system");
  assertStringIncludes(p, "empty_layer = nobody has loaded this data yet");
  assertStringIncludes(p, "geochemistry: no_source");
  assertStringIncludes(p, "contacts: not_scored");
});

Deno.test("an unmeasured layer is shown as NOT AVAILABLE, never as zero", () => {
  const p = buildMissionPrompt(summary({ contactDistanceM: null, elevationM: null }));
  assertStringIncludes(p, "nearest geological contact: NOT AVAILABLE");
  assertStringIncludes(p, "elevation: NOT AVAILABLE");
  // A model shown "0 m" would reason about a contact underfoot.
  assertEquals(p.includes("nearest geological contact: 0 m"), false);
});

Deno.test("recording nothing is presented as a finding, not as an absence of input", () => {
  const p = buildMissionPrompt(summary({ observations: [], photoCount: 0 }));
  assertStringIncludes(p, "NOTHING RECORDED. This is itself a finding");
});

Deno.test("the Somali instruction demands equal meaning, not a simpler version", () => {
  const p = buildMissionPrompt(summary());
  assertStringIncludes(p, "same geological meaning at the same confidence");
  assertStringIncludes(p, "do not simplify it");
  assertStringIncludes(p, "xidid quartz ah (quartz vein)");
});

// ── The parser ──────────────────────────────────────────────────────────────

const GOOD = JSON.stringify({
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
  ],
  missing_evidence: ["assay", "geochemistry"],
  recommendations: [
    { action: "record_vein_orientation", priority: 2, because_of: ["quartz_vein"] },
    { action: "collect_rock_samples", priority: 1, because_of: ["quartz_vein"] },
  ],
  narrative: {
    en: { summary: "Moderate geological interest.", interpretation: "Vein in basement near a fault." },
    so: { summary: "Xiiso juqraafi dhexdhexaad ah.", interpretation: "Xidid basement-ka ku dhow jeex." },
  },
});

Deno.test("a well-formed response parses, with recommendations in priority order", () => {
  const { findings, discarded } = parseMissionFindings(GOOD, META);
  assertEquals(discarded, []);
  assertEquals(findings!.interest, "moderate");
  assertEquals(findings!.evidence.length, 2);
  assertEquals(findings!.missingEvidence, ["assay", "geochemistry"]);
  // Ordering is part of the advice, so it is normalised here rather than left to
  // whatever order the model happened to emit.
  assertEquals(findings!.recommendations.map((r) => r.action),
    ["collect_rock_samples", "record_vein_orientation"]);
  assertEquals(findings!.model, "test-model");
});

Deno.test("markdown fences are tolerated", () => {
  const { findings } = parseMissionFindings("```json\n" + GOOD + "\n```", META);
  assertEquals(findings!.evidence.length, 2);
});

Deno.test("THE ENGINE BOUNDARY: a score returned by the model is DISCARDED", () => {
  const withScore = JSON.parse(GOOD);
  withScore.prospectivity_score = 0.91;
  withScore.probability = 0.7;
  withScore.grade = "3.2 g/t";
  const { findings, discarded } = parseMissionFindings(JSON.stringify(withScore), META);

  // Nothing score-like survives, and the refusal is recorded so a model doing this
  // repeatedly is visible rather than silently trimmed.
  const json = JSON.stringify(findings);
  assertEquals(json.includes("0.91"), false);
  assertEquals(json.includes("prospectivity"), false);
  assertEquals(json.includes("grade"), false);
  assertEquals(discarded.filter((d) => d.includes("the engine owns the score")).length, 3);
  // And the assessment itself is still usable.
  assertEquals(findings!.evidence.length, 2);
});

Deno.test("a sentence where a code belongs is REFUSED, not mangled into one", () => {
  const bad = JSON.parse(GOOD);
  bad.evidence.push({
    type: "There is a quartz vein visible on the outcrop",
    origin: "field_observation", status: "present", strength: "strong",
    confidence: "high", significance: "it might mean gold",
  });
  bad.missing_evidence.push("we have no assay results at all");
  const { findings, discarded } = parseMissionFindings(JSON.stringify(bad), META);
  // A sentence in a code field cannot be rendered in another language, which is
  // the entire reason the codes exist.
  assertEquals(findings!.evidence.length, 2);
  assertEquals(findings!.missingEvidence, ["assay", "geochemistry"]);
  assertEquals(discarded.some((d) => d.includes("not a snake_case code")), true);
  assertEquals(discarded.some((d) => d.includes("is not a code")), true);
});

Deno.test("unknown enum values fall back to the CAUTIOUS answer", () => {
  const odd = JSON.parse(GOOD);
  odd.interest = "extremely promising";
  odd.confidence = "very high";
  odd.evidence[0].strength = "overwhelming";
  odd.evidence[0].status = "verified";
  const { findings } = parseMissionFindings(JSON.stringify(odd), META);
  // A model inventing a stronger word does not get a stronger reading.
  assertEquals(findings!.interest, "limited");
  assertEquals(findings!.confidence, "low");
  assertEquals(findings!.evidence[0].strength, "weak");
  assertEquals(findings!.evidence[0].status, "present");
});

Deno.test("a missing confidence is LOW, not medium", () => {
  const noConf = JSON.parse(GOOD);
  delete noConf.confidence;
  assertEquals(parseMissionFindings(JSON.stringify(noConf), META).findings!.confidence, "low");
});

Deno.test("one language of narrative is no narrative at all", () => {
  const half = JSON.parse(GOOD);
  half.narrative.so.summary = "";
  const { findings, discarded } = parseMissionFindings(JSON.stringify(half), META);
  // Handing a Somali reader an English report is not a partial success.
  assertEquals(findings!.narrative, undefined);
  assertEquals(discarded.some((d) => d.includes("only one language")), true);
  // The findings still stand on their own — that is why they are codes.
  assertEquals(findings!.evidence.length, 2);
});

Deno.test("unparseable output yields NOTHING, not a hollow report", () => {
  for (const bad of ["not json at all", "", "[]", "null", "{oops"]) {
    const { findings, discarded } = parseMissionFindings(bad, META);
    if (findings != null) {
      // "[]" parses as an array; it must still not become a report.
      assertEquals(findings.evidence.length, 0);
      assertEquals(findings.missingEvidence.length, 0);
    } else {
      assertEquals(discarded.length > 0, true);
    }
  }
});

Deno.test("the parsed narrative is still put through the language guard", () => {
  const bad = JSON.parse(GOOD);
  bad.narrative.en.summary = "There is a 70% chance of gold.";
  const { findings } = parseMissionFindings(JSON.stringify(bad), META);
  // The parser does not police prose — that is missionFindings' job, and this
  // confirms the two compose rather than each assuming the other did it.
  assertEquals(findForbiddenLanguage(findings!).length > 0, true);
});

Deno.test("an out-of-range priority becomes last, not first", () => {
  const odd = JSON.parse(GOOD);
  odd.recommendations = [{ action: "do_something", priority: 99, because_of: [] }];
  assertEquals(parseMissionFindings(JSON.stringify(odd), META).findings!.recommendations[0].priority, 3);
});

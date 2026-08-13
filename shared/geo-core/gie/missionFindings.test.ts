// The findings contract: language-free structure, and the guards on it.
//
//   deno test shared/geo-core/gie/missionFindings.test.ts
//
// Two things are being defended. First, that a report can be re-rendered in
// another language with no model call and no possibility of the two versions
// disagreeing — which is a property of the SHAPE, so it is tested as one. Second,
// that no probability or certainty claim can reach a reader, in either language.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  cappedConfidence, findForbiddenLanguage, isUsableFindings,
  MISSION_FINDINGS_VERSION, withoutForbiddenNarrative,
  type MissionFindings,
} from "./missionFindings.ts";

function findings(over: Partial<MissionFindings> = {}): MissionFindings {
  return {
    version: MISSION_FINDINGS_VERSION,
    commodity: "gold",
    interest: "moderate",
    confidence: "medium",
    evidence: [
      {
        type: "quartz_vein", origin: "field_observation", status: "present",
        strength: "moderate", confidence: "medium", significance: "hydrothermal_indicator",
      },
      {
        type: "fault_proximity", origin: "engine_layer", status: "present",
        strength: "moderate", confidence: "medium", significance: "fluid_pathway",
        value: 340,
      },
      {
        type: "geochemistry", origin: "engine_layer", status: "no_source",
        strength: "absent", confidence: "low", significance: "not_available",
      },
    ],
    missingEvidence: ["assay", "geochemistry", "alteration_mapping"],
    recommendations: [
      { action: "collect_rock_samples", priority: 1, becauseOf: ["quartz_vein"] },
      { action: "record_vein_orientation", priority: 2, becauseOf: ["quartz_vein"] },
    ],
    model: "gemini-2.0-flash",
    analysedAt: Date.parse("2026-08-10T00:00:00.000Z"),
    ...over,
  };
}

Deno.test("the findings carry no language at all", () => {
  const f = findings({ narrative: undefined });
  // Every field a reader sees is derived from these. Nothing here is a sentence,
  // so there is nothing to translate and nothing that can drift.
  const json = JSON.stringify(f);
  assertEquals(/[a-z]{4,} [a-z]{4,} [a-z]{4,}/.test(json.replace(/"[a-z_]+":/g, "")), false);
  assertEquals(f.evidence.every((e) => /^[a-z0-9_]+$/.test(e.type)), true);
  assertEquals(f.recommendations.every((r) => /^[a-z0-9_]+$/.test(r.action)), true);
  assertEquals(f.missingEvidence.every((m) => /^[a-z0-9_]+$/.test(m)), true);
});

Deno.test("CONFIDENCE CANNOT DIFFER BY LANGUAGE — there is one field", () => {
  // Not a behavioural test but a structural one, which is the point: the
  // requirement is met by the shape rather than by a model being careful.
  const f = findings();
  const keys = Object.keys(f);
  assertEquals(keys.filter((k) => k.toLowerCase().includes("confidence")), ["confidence"]);
  // And the narrative — the only language-bearing part — has no confidence in it.
  const narrative = { en: { summary: "", interpretation: "" }, so: { summary: "", interpretation: "" } };
  assertEquals(Object.keys(narrative.en).some((k) => k.includes("confidence")), false);
});

Deno.test("there is nowhere to put a probability", () => {
  const f = findings();
  const keys = JSON.stringify(f).match(/"([a-zA-Z_]+)":/g) ?? [];
  for (const bad of ["probability", "percent", "chance", "odds", "likelihood"]) {
    assertEquals(keys.some((k) => k.toLowerCase().includes(bad)), false, `found ${bad}`);
  }
});

Deno.test("forbidden ENGLISH is caught in the narrative", () => {
  for (const text of [
    "There is a 70% chance of gold here.",
    "The probability of mineralisation is high.",
    "This is confirmed gold.",
    "70 percent likely",
    "The odds are good.",
    "We guarantee a deposit.",
    "This is definitely economic.",
  ]) {
    const v = findForbiddenLanguage(findings({
      narrative: { en: { summary: text, interpretation: "" }, so: { summary: "", interpretation: "" } },
    }));
    assertEquals(v.length > 0, true, `not caught: ${text}`);
  }
});

Deno.test("forbidden SOMALI is caught too", () => {
  // A guard that only reads English would let the same claim through in the
  // language most of these users read.
  for (const text of [
    "Waxaa jira boqolkiiba 70 oo dahab.",
    "Suurtagalnimada macdanaysashada waa sare.",
    "Kani waa hubaal dahab.",
    "Waxaa xaqiijisan dahab.",
    "Waxaan bixinaynaa dammaanad.",
  ]) {
    const v = findForbiddenLanguage(findings({
      narrative: { en: { summary: "", interpretation: "" }, so: { summary: text, interpretation: "" } },
    }));
    assertEquals(v.length > 0, true, `not caught: ${text}`);
  }
});

Deno.test("ordinary geological prose passes, in both languages", () => {
  // The guard must not be so blunt that a real report cannot be written.
  const v = findForbiddenLanguage(findings({
    narrative: {
      en: {
        summary: "Field evidence indicates a geologically interesting zone with quartz vein " +
          "observations and favourable structural context. No assay or geochemical confirmation exists.",
        interpretation: "The vein sits 340 m from a mapped fault in metamorphic basement, a setting " +
          "consistent with orogenic styles. Evidence strength is moderate and confidence is limited " +
          "by the absence of laboratory work.",
      },
      so: {
        summary: "Caddeymaha goobta waxay tilmaamayaan aag juqraafi ahaan xiiso leh, oo lagu arkay " +
          "xidid quartz ah (quartz vein) iyo qaab-dhismeed taageeraya. Assay ama geochemistry ma jirto.",
        interpretation: "Xididku wuxuu 340 m u jiraa jeex la khariidadeeyay (fault) oo basement " +
          "metamorphic ah, taasoo waafaqsan qaabab orogenic. Xoogga caddeymuhu waa dhexdhexaad.",
      },
    },
  }));
  assertEquals(v, []);
});

Deno.test("a bad narrative is DROPPED, the findings are kept", () => {
  // The structure is the report; the prose is a convenience. Discarding a whole
  // assessment over one sentence would punish the geologist for the model's slip.
  const { findings: kept, violations } = withoutForbiddenNarrative(findings({
    narrative: {
      en: { summary: "70% chance of gold", interpretation: "" },
      so: { summary: "", interpretation: "" },
    },
  }));
  // "70% chance of gold" trips two patterns — the percentage and the phrasing.
  // Both are real findings, so the count is not pinned to one.
  assertEquals(violations.length >= 1, true);
  assertEquals(violations.every((v) => v.where === "en.summary"), true);
  assertEquals(kept.narrative, undefined);
  // Everything a geologist needs is still there.
  assertEquals(kept.evidence.length, 3);
  assertEquals(kept.missingEvidence.length, 3);
  assertEquals(kept.recommendations.length, 2);
  assertEquals(isUsableFindings(kept), true);
});

Deno.test("a clean narrative survives untouched", () => {
  const original = findings({
    narrative: {
      en: { summary: "Moderate geological interest.", interpretation: "Quartz veining in basement." },
      so: { summary: "Xiiso juqraafi dhexdhexaad ah.", interpretation: "Xidid quartz basement-ka." },
    },
  });
  const { findings: kept, violations } = withoutForbiddenNarrative(original);
  assertEquals(violations, []);
  assertEquals(kept, original);
});

Deno.test("CONFIDENCE IS CAPPED BY THE EVIDENCE, not by the model's opinion", () => {
  // A model asked for a confidence level will happily return HIGH on two
  // observations and no assay. This is the arithmetic it should have done.
  // The default fixture has two layers actually present. Two is LOW, whatever the
  // model says — and that is the honest answer for a site with no laboratory work
  // and a couple of observations.
  assertEquals(cappedConfidence(findings({ confidence: "high" })), "low");

  // Three present layers earns MEDIUM. Still not HIGH: the assay is missing.
  const three = findings({
    confidence: "high",
    evidence: [
      { type: "a", origin: "field_observation", status: "present", strength: "moderate", confidence: "medium", significance: "x" },
      { type: "b", origin: "engine_layer", status: "present", strength: "moderate", confidence: "medium", significance: "x" },
      { type: "c", origin: "engine_layer", status: "present", strength: "weak", confidence: "low", significance: "x" },
    ],
  });
  assertEquals(cappedConfidence(three), "medium");

  // Even a rich field record cannot reach HIGH while the laboratory work is
  // missing — which in greenfield exploration it always is.
  const rich = findings({
    confidence: "high",
    evidence: Array.from({ length: 6 }, (_, i) => ({
      type: `obs_${i}`, origin: "field_observation" as const, status: "present" as const,
      strength: "strong" as const, confidence: "high" as const, significance: "x",
    })),
  });
  assertEquals(cappedConfidence(rich), "medium");

  // With assay and geochemistry in hand, HIGH becomes reachable.
  assertEquals(cappedConfidence({ ...rich, missingEvidence: ["alteration_mapping"] }), "high");
});

Deno.test("the cap never RAISES what the model said", () => {
  // It is a ceiling, not a correction. A model that reports LOW confidence knows
  // something the arithmetic does not.
  const rich = findings({
    confidence: "low",
    missingEvidence: [],
    evidence: Array.from({ length: 6 }, (_, i) => ({
      type: `obs_${i}`, origin: "field_observation" as const, status: "present" as const,
      strength: "strong" as const, confidence: "high" as const, significance: "x",
    })),
  });
  assertEquals(cappedConfidence(rich), "low");
});

Deno.test("interest and confidence are INDEPENDENT axes", () => {
  // A site can be confidently uninteresting. Collapsing the two is how an app
  // starts telling people how sure it is that there is gold.
  const dull = findings({
    interest: "none",
    confidence: "medium",
    evidence: Array.from({ length: 4 }, (_, i) => ({
      type: `obs_${i}`, origin: "engine_layer" as const, status: "present" as const,
      strength: "absent" as const, confidence: "medium" as const, significance: "x",
    })),
  });
  assertEquals(dull.interest, "none");
  assertEquals(cappedConfidence(dull), "medium");
});

Deno.test("an empty analysis is not a cautious one — it is refused", () => {
  assertEquals(isUsableFindings(findings({ evidence: [], missingEvidence: [] })), false);
  assertEquals(isUsableFindings(findings({ model: "" })), false);
  assertEquals(isUsableFindings(findings({ version: 99 })), false);
  // Nothing found but the gaps named IS a real report: "I looked and there is
  // nothing here" is information.
  assertEquals(isUsableFindings(findings({ evidence: [], missingEvidence: ["assay"] })), true);
});

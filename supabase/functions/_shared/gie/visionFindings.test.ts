// The vision→evidence converter is on a short leash. These pin the leash.
//
//   deno test supabase/functions/_shared/gie/visionFindings.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { visualObservationsToEvidence } from "./visionFindings.ts";
import type { VisualObservation, VisualAspect } from "./vision.ts";

const ALL_ASPECTS: VisualAspect[] =
  ["texture", "color", "mineral", "vein", "alteration", "weathering", "structure", "other"];

function obs(aspect: VisualAspect, clarity: number): VisualObservation {
  return { statement: `${aspect} seen`, statementSo: `${aspect} la arkay`, aspect, clarity };
}

Deno.test("every aspect maps to visual-only, unverified, low, never strong", () => {
  const evidence = visualObservationsToEvidence(ALL_ASPECTS.map((a) => obs(a, 1)));
  assertEquals(evidence.length, ALL_ASPECTS.length);
  for (const e of evidence) {
    assertEquals(e.origin, "photograph");
    assertEquals(e.status, "present");
    assertEquals(e.source, "gemini_vision");
    assertEquals(e.verificationStatus, "unverified");
    assertEquals(e.confidence, "low");
    // Never strong, even at clarity 1 — a photo is never proof of ore.
    assertEquals(e.strength === "strong", false);
  }
});

Deno.test("no aspect produces a mineral/deposit claim (req 5)", () => {
  const evidence = visualObservationsToEvidence(ALL_ASPECTS.map((a) => obs(a, 0.9)));
  for (const e of evidence) {
    assertEquals(/gold|deposit|ore|mineralis|mineraliz/i.test(e.type), false);
    assertEquals(/gold|deposit|ore|mineralis|mineraliz/i.test(e.significance), false);
  }
});

Deno.test("clarity decides weak vs moderate, with a configurable threshold", () => {
  assertEquals(visualObservationsToEvidence([obs("vein", 0.9)])[0].strength, "moderate");
  assertEquals(visualObservationsToEvidence([obs("vein", 0.2)])[0].strength, "weak");
  // Threshold is a parameter, not a magic number: raise it and the same clarity is weak.
  assertEquals(visualObservationsToEvidence([obs("vein", 0.7)], 0.95)[0].strength, "weak");
});

Deno.test("empty observations produce no evidence", () => {
  assertEquals(visualObservationsToEvidence([]).length, 0);
});

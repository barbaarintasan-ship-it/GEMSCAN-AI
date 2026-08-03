// Which extra photos get asked for.
//
// The requirement these tests exist for is "never ask for unnecessary photos".
// Most of them are therefore about NOT asking.
import { shotNeedsFor, SUFFICIENT_CONFIDENCE, MAX_REQUESTS } from "../shotNeeds";

describe("a confident result asks for nothing", () => {
  test("at the threshold, nothing more is needed", () => {
    expect(shotNeedsFor({ overallConfidence: SUFFICIENT_CONFIDENCE, roles: ["context"] })).toEqual([]);
  });

  test("above it, nothing either — even with a single photo", () => {
    expect(shotNeedsFor({ overallConfidence: 0.95, roles: ["context"] })).toEqual([]);
  });

  test("a report listing gaps is still ignored once the answer is settled", () => {
    expect(shotNeedsFor({
      overallConfidence: 0.9,
      roles: ["context"],
      missingInformation: ["a fresh broken surface would help"],
    })).toEqual([]);
  });
});

describe("a weak result asks only for what is missing", () => {
  test("the report's own words decide what is asked for", () => {
    const needs = shotNeedsFor({
      overallConfidence: 0.3,
      roles: ["context", "surface_closeup"],
      missingInformation: ["No fresh broken surface is visible."],
    });
    expect(needs).toEqual(["fresh_surface"]);
  });

  test("a view the sample already has is never requested", () => {
    const needs = shotNeedsFor({
      overallConfidence: 0.3,
      roles: ["context"],
      missingInformation: ["wider context of the outcrop would help"],
    });
    // "wider_context" is satisfied by the context photo already on the sample.
    expect(needs).not.toContain("wider_context");
  });

  test("a close-up is not requested when a key-feature shot already covers it", () => {
    const needs = shotNeedsFor({
      overallConfidence: 0.2,
      roles: ["context", "key_feature"],
      missingInformation: ["closer detail needed"],
    });
    expect(needs).not.toContain("closer");
  });

  test("requests are capped — a list of seven is a list nobody does", () => {
    const needs = shotNeedsFor({
      overallConfidence: 0.1,
      roles: [],
      missingInformation: [
        "closer detail, a fresh broken surface, mineral grains, a quartz vein, another angle, wider context, weathered alteration",
      ],
    });
    expect(needs.length).toBeLessThanOrEqual(MAX_REQUESTS);
  });

  test("priority order holds: the specimen close-up is asked for before the wide shot", () => {
    const needs = shotNeedsFor({
      overallConfidence: 0.1,
      roles: [],
      missingInformation: ["closer detail and wider context"],
    });
    expect(needs.indexOf("closer")).toBeLessThan(needs.indexOf("wider_context"));
  });
});

describe("when the report says nothing about what is missing", () => {
  test("a thin sample gets one request, not a shopping list", () => {
    expect(shotNeedsFor({ overallConfidence: 0.2, roles: ["context"] })).toEqual(["closer"]);
  });

  test("a well-covered sample gets none — there is nothing to point at", () => {
    expect(shotNeedsFor({
      overallConfidence: 0.2,
      roles: ["context", "surface_closeup", "key_feature", "scale_reference"],
    })).toEqual([]);
  });
});

describe("an unknown confidence is not treated as a confident answer", () => {
  test("null confidence with a thin sample still asks", () => {
    expect(shotNeedsFor({ overallConfidence: null, roles: ["context"] })).toEqual(["closer"]);
  });
});

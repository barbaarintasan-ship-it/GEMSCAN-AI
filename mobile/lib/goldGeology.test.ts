import { regionalGeologyContext } from "./goldGeology";

const L = (en: string) => en; // language-independent for tests

describe("regionalGeologyContext", () => {
  it("flags the northern Somali basement as a favorable, documented gold province", () => {
    const c = regionalGeologyContext(10.5, 47.0, L, false); // Golis / northern basement
    expect(c.favorable).toBe(true);
    expect(c.provinceName).toMatch(/Basement/i);
    expect(c.documentedNearby).toBe(true); // Golis occurrence within radius
    expect(c.line).toMatch(/gold mineralization/i);
    expect(c.source).toMatch(/USGS/);
  });

  it("returns an honest 'no documented formations' result outside any province", () => {
    const c = regionalGeologyContext(2.04, 45.34, L, false); // Mogadishu area
    expect(c.favorable).toBe(false);
    expect(c.provinceName).toBeNull();
    expect(c.documentedNearby).toBe(false);
    expect(c.line).toMatch(/No major documented gold-bearing formations/i);
  });

  it("recognizes the Bur Massif basement but does not call it a gold province", () => {
    const c = regionalGeologyContext(3.1, 43.7, L, false);
    expect(c.provinceName).toMatch(/Bur/i);
    expect(c.favorable).toBe(false);
    expect(c.line).toMatch(/crystalline basement/i);
  });

  it("never claims a specific point contains gold", () => {
    const c = regionalGeologyContext(10.5, 47.0, L, false);
    expect(c.line.toLowerCase()).not.toMatch(/contains gold|gold is present|confirmed gold/);
  });
});

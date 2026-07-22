import { regionalGeologyContext, geologyByPlace } from "./goldGeology";

const L = (en: string) => en; // language-independent for tests

describe("regionalGeologyContext (GPS)", () => {
  it("flags the northern Somali basement as a favorable, documented gold province", () => {
    const c = regionalGeologyContext(10.5, 47.0, L, false); // Golis / northern basement
    expect(c.favorable).toBe(true);
    expect(c.provinceName).toMatch(/Basement/i);
    expect(c.documentedNearby).toBe(true);
    expect(c.line).toMatch(/gold mineralization/i);
    expect(c.resolvedBy).toBe("gps");
    expect(c.source).toMatch(/USGS/);
  });

  it("recognizes major global gold provinces", () => {
    expect(regionalGeologyContext(-26.8, 27.5, L, false).favorable).toBe(true); // Witwatersrand, ZA
    expect(regionalGeologyContext(-30.7, 121.5, L, false).favorable).toBe(true); // Kalgoorlie, AU
    expect(regionalGeologyContext(40.8, -116.3, L, false).favorable).toBe(true); // Carlin, USA
    expect(regionalGeologyContext(6.2, -1.8, L, false).favorable).toBe(true); // Ashanti, Ghana
    expect(regionalGeologyContext(37.3, 120.5, L, false).favorable).toBe(true); // Jiaodong, China
    expect(regionalGeologyContext(-19.6, 47.0, L, false).favorable).toBe(true); // Central Madagascar
  });

  it("returns a professional, non-negative result outside any known province", () => {
    const c = regionalGeologyContext(2.04, 45.34, L, false); // Mogadishu area
    expect(c.favorable).toBe(false);
    expect(c.provinceName).toBeNull();
    expect(c.documentedNearby).toBe(false);
    expect(c.line).toMatch(/No geological reference data is currently available/i);
    // Part 3: never implies gold is absent.
    expect(c.line.toLowerCase()).not.toMatch(/no gold|without gold|gold-free/);
  });

  it("recognizes the Bur Massif basement but does not call it a gold province", () => {
    const c = regionalGeologyContext(3.1, 43.7, L, false);
    expect(c.provinceName).toMatch(/Bur/i);
    expect(c.favorable).toBe(false);
  });

  it("never claims a specific point contains gold", () => {
    const c = regionalGeologyContext(10.5, 47.0, L, false);
    expect(c.line.toLowerCase()).not.toMatch(/contains gold|gold is present|confirmed gold/);
  });
});

describe("geologyByPlace (manual fallback)", () => {
  it("returns null when no country is entered", () => {
    expect(geologyByPlace({}, L, false)).toBeNull();
    expect(geologyByPlace({ country: "" }, L, false)).toBeNull();
  });

  it("resolves a curated country to a favorable, source-backed context", () => {
    const c = geologyByPlace({ country: "Ghana", region: "Ashanti" }, L, false)!;
    expect(c).not.toBeNull();
    expect(c.favorable).toBe(true);
    expect(c.resolvedBy).toBe("manual");
    expect(c.provinceName).toBe("Ghana");
    expect(c.line).toMatch(/Ghana/);
    expect(c.locationLabel).toMatch(/Ashanti, Ghana/);
  });

  it("matches common aliases without false-matching short ones", () => {
    expect(geologyByPlace({ country: "USA" }, L, false)!.provinceName).toBe("United States");
    expect(geologyByPlace({ country: "united states of america" }, L, false)!.provinceName).toBe("United States");
    // "belarus" contains "us" but must NOT match the United States alias.
    expect(geologyByPlace({ country: "Belarus" }, L, false)!.provinceName).toBeNull();
  });

  it("gives an honest, non-negative message for an uncurated country", () => {
    const c = geologyByPlace({ country: "Atlantis" }, L, false)!;
    expect(c.favorable).toBe(false);
    expect(c.provinceName).toBeNull();
    expect(c.line).toMatch(/No geological reference data is currently available/i);
    expect(c.line.toLowerCase()).not.toMatch(/no gold|gold-free/);
  });
});

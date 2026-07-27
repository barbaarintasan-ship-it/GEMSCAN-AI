// Unit tests for the GIE GATHER stage (pure; no DB, no AI).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { assemble, fieldEvidence, gather, geoEvidence, runProviders } from "./gather.ts";
import type { SampleInput } from "./types.ts";
import type { GeoContextProvider, ProviderContribution } from "../geocontext/types.ts";

const SAMPLE: SampleInput = {
  id: "s1", name: "Milxa Quartz Vein 01", lat: 2.05, lng: 45.32,
  altitudeM: 12, gpsAccuracyM: 6, collectedAt: "2026-07-27T10:00:00Z",
  terrainType: "outcrop", geologicalEnvironment: "vein system", fieldObservations: "iron oxide staining",
  hostRock: { rockClass: "granite", texture: "coarse", weathering: "fresh", notes: "pegmatitic" },
  minerals: [{ mineral: "quartz" }, { mineral: "feldspar" }],
  alteration: { alterationType: "silicification", intensity: "moderate" },
  structural: [{ structureType: "vein", strikeDeg: 120, dipDeg: 70 }],
};

const CONTRIB: ProviderContribution[] = [
  {
    provider: "occurrence", category: "spatial", priority: 30, confidence: 0.6,
    data: {}, datasets: [{ datasetId: "d1", source: "USGS MRDS", version: "2023" }],
    evidence: [
      { statement: "Au occurrence 320 m", weight: 0.7, tier: "mapped", provenance: { source: "USGS MRDS" } },
      { statement: "Cu occurrence 900 m", weight: 0.4, tier: "mapped" },
    ],
  },
  {
    provider: "geology", category: "spatial", priority: 10, confidence: 0.5,
    data: {}, datasets: [{ source: "UNESCO" }],
    evidence: [{ statement: "Granitic intrusion mapped at location", weight: 0.6, tier: "regional" }],
  },
];

Deno.test("fieldEvidence turns sample data into observation nodes", () => {
  const f = fieldEvidence(SAMPLE);
  assert(f.every((n) => n.evType === "field" && n.isObservation));
  // location + terrain + environment + host rock + host note + 2 minerals + alteration + structure + note
  assert(f.length >= 9);
  assert(f.some((n) => n.statement.includes("Host rock recorded in field: granite")));
  assert(f.some((n) => n.statement.includes("Mineral observed in field: quartz")));
  assert(f.some((n) => n.statement.includes("Alteration observed: silicification")));
  assert(f.some((n) => n.statement.includes("Structure measured: vein 120/70")));
});

Deno.test("high-accuracy GPS yields higher quality than poor", () => {
  const good = fieldEvidence(SAMPLE)[0];
  const bad = fieldEvidence({ ...SAMPLE, gpsAccuracyM: 55 })[0];
  assert(good.quality > bad.quality);
});

Deno.test("geoEvidence maps provider items to typed nodes with dataset ids", () => {
  const g = geoEvidence(CONTRIB);
  assertEquals(g.length, 3);
  assert(g.some((n) => n.evType === "occurrence" && n.datasetId === "d1"));
  assert(g.some((n) => n.evType === "spatial" && n.statement.includes("Granitic")));
  assert(g.every((n) => !n.isObservation)); // provider-derived
});

Deno.test("gather assigns stable ids and tallies by type", () => {
  const set = gather(SAMPLE, CONTRIB, ["occurrence", "geology"], ["knowledge"]);
  assertEquals(set.nodes[0].id, "e1");
  assertEquals(set.nodes[set.nodes.length - 1].id, `e${set.nodes.length}`);
  assert(new Set(set.nodes.map((n) => n.id)).size === set.nodes.length); // unique
  assert(set.countsByType.field >= 9);
  assertEquals(set.countsByType.occurrence, 2); // two occurrence items in CONTRIB
  assertEquals(set.countsByType.spatial, 1);
  assertEquals(set.providersFailed, ["knowledge"]);
});

Deno.test("assemble empty set is valid (no evidence)", () => {
  const set = assemble([], [], []);
  assertEquals(set.nodes.length, 0);
  assertEquals(set.countsByType.field, 0);
});

Deno.test("runProviders isolates failures and timeouts", async () => {
  const ok: GeoContextProvider = {
    name: "geology", category: "spatial", priority: 10,
    fetch: () => Promise.resolve(CONTRIB[1]),
  };
  const boom: GeoContextProvider = {
    name: "occurrence", category: "spatial", priority: 30,
    fetch: () => Promise.reject(new Error("db down")),
  };
  const slow: GeoContextProvider = {
    name: "knowledge", category: "knowledge", priority: 20,
    fetch: () => new Promise((res) => setTimeout(() => res(CONTRIB[0]), 50)),
  };
  const r = await runProviders([ok, boom, slow], { lat: 2, lng: 45, radiusM: 25000 }, 10);
  assertEquals(r.providersRun, ["geology"]);
  assert(r.providersFailed.includes("occurrence"));
  assert(r.providersFailed.includes("knowledge")); // timed out at 10ms
  assertEquals(r.contributions.length, 1);
});

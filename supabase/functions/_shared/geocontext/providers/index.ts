// Assemble the full provider set from a data gateway.
import type { GeoContextProvider } from "../types.ts";
import type { GeoDataGateway } from "./gateway.ts";
import { makeGeologyProvider } from "./geology.ts";
import { makeOccurrenceProvider } from "./occurrence.ts";
import { makeKnowledgeProvider } from "./knowledge.ts";
import { makeCommunityProvider } from "./community.ts";
import { makeMineralAssociationProvider } from "./mineralAssociation.ts";
import { makeGeologicalKnowledgeProvider } from "./geologicalKnowledge.ts";
import { makeStructuralGeologyProvider } from "./structuralGeology.ts";

export function buildProviders(gw: GeoDataGateway): GeoContextProvider[] {
  return [
    makeGeologyProvider(gw),
    makeStructuralGeologyProvider(gw),   // EMIE — dormant until structural data is loaded
    makeOccurrenceProvider(gw),
    makeKnowledgeProvider(gw),
    makeGeologicalKnowledgeProvider(gw), // EMIE — rock/environment → commodity knowledge
    makeMineralAssociationProvider(gw),  // EMIE — mineral assemblage → interpreted system
    makeCommunityProvider(gw),
  ];
}

/**
 * The providers that read the SPECIMEN, and never the place it was found.
 *
 * `buildProviders` above is the full engine and is deliberately untouched — the
 * `geocontext` endpoint and every exploration path still get all seven.
 *
 * This subset exists for personal samples. The four left out — geology,
 * structuralGeology, occurrence, community — all answer questions about
 * COORDINATES: what unit is mapped here, what faults are near, what has been
 * found nearby, what other people reported here. Running them on a rock somebody
 * picked up gave a private collection a prospectivity reading of wherever the
 * phone happened to be standing, which is a statement about the ground that
 * nobody asked for and that the collector has no way to check.
 *
 * The three kept — knowledge, geologicalKnowledge, mineralAssociation — key off
 * `query.sample`: the host rocks, minerals, alteration and structures the
 * geologist typed in. That is a description of the specimen. Knowing what
 * tourmaline is involves no claim about where you are.
 *
 * NOTHING here changes how any provider works. It changes which questions are
 * asked, and of what.
 */
export function buildKnowledgeProviders(gw: GeoDataGateway): GeoContextProvider[] {
  return [
    makeKnowledgeProvider(gw),
    makeGeologicalKnowledgeProvider(gw),
    makeMineralAssociationProvider(gw),
  ];
}

export type { GeoDataGateway } from "./gateway.ts";

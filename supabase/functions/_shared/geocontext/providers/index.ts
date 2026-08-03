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

export type { GeoDataGateway } from "./gateway.ts";

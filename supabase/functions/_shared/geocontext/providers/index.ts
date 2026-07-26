// Assemble the full provider set from a data gateway.
import type { GeoContextProvider } from "../types.ts";
import type { GeoDataGateway } from "./gateway.ts";
import { makeGeologyProvider } from "./geology.ts";
import { makeOccurrenceProvider } from "./occurrence.ts";
import { makeKnowledgeProvider } from "./knowledge.ts";
import { makeCommunityProvider } from "./community.ts";
import { makeMineralAssociationProvider } from "./mineralAssociation.ts";

export function buildProviders(gw: GeoDataGateway): GeoContextProvider[] {
  return [
    makeGeologyProvider(gw),
    makeOccurrenceProvider(gw),
    makeKnowledgeProvider(gw),
    makeMineralAssociationProvider(gw),
    makeCommunityProvider(gw),
  ];
}

export type { GeoDataGateway } from "./gateway.ts";

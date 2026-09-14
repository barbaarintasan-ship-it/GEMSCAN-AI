// Map-layer and terrain providers (Architecture §7.7).
//
// A geologist does not reason from point occurrences alone — they read
// STRUCTURE and LANDFORM. These two providers add that, using the same
// GeoContextProvider interface as everything else, so the engine fuses them
// without knowing they are new.
//
// Neither invents data. With no map features or terrain in the pack they
// contribute nothing, which is the honest answer and the current state for
// terrain (no DEM is ingested yet — §7.7 "Data status").
import { terrainIndexFor } from "./terrainIndex";
// featuresNear/intersectionsOf/NearbyFeature moved to the shared geological
// core (shared/geo-core/geo/mapFeatures.ts) — Solo→Team shared-targeting Phase
// 1 — so Team's server-side scoring can call the identical structural-evidence
// functions. Re-exported below so every existing import of these three names
// from "./terrainProviders" (targeting.ts, evidenceCoverage.ts) is unchanged.
import { featuresNear, intersectionsOf, type NearbyFeature } from "./mapFeatures.ts";
import {
  haversineM,
} from "../../../shared/geo-core/geo/spatial.ts";
import type {
  EvidenceItem,
  GeoContextProvider,
  GeoQuery,
  ProviderContribution,
} from "../../../shared/geo-core/types.ts";
import type {
  MapFeatureKind,
  PackData,
  PackTerrainCell,
} from "../../../shared/geo-core/pack/types.ts";

export { featuresNear, intersectionsOf, type NearbyFeature };

// ── Map layers ──────────────────────────────────────────────────────────────
/**
 * How much each mapped structure matters as an exploration signal.
 *
 * Faults and contacts are where fluids moved and where units meet — the classic
 * places to look. A lineament is a possible structure, not a confirmed one, so
 * it is weighted lower. Drainage matters for float and placer, not for a lode
 * target, so it contributes context rather than prospectivity.
 */
const KIND_WEIGHT: Record<MapFeatureKind, number> = {
  fault: 0.7,
  contact: 0.65,
  lineament: 0.4,
  drainage: 0.25,
  other: 0.15,
};

const KIND_LABEL: Record<MapFeatureKind, string> = {
  fault: "Fault",
  contact: "Geological contact",
  lineament: "Lineament",
  drainage: "Drainage",
  other: "Mapped feature",
};

/** Proximity falloff: right on a structure is the signal; 5 km away is not. */
function structureWeight(kind: MapFeatureKind, distanceM: number, radiusM: number): number {
  const base = KIND_WEIGHT[kind] ?? 0.15;
  const proximity = Math.max(0, 1 - distanceM / Math.max(radiusM, 1));
  return base * proximity;
}

export function makeMapLayerProvider(data: () => PackData): GeoContextProvider {
  return {
    name: "map_layers",
    category: "spatial",
    priority: 15, // between geology (10) and occurrence (20)
    async fetch(q: GeoQuery): Promise<ProviderContribution> {
      const near = featuresNear(data().mapFeatures, q.lat, q.lng, q.radiusM);
      const evidence: EvidenceItem[] = near.slice(0, 8).map((f) => ({
        statement: `${KIND_LABEL[f.kind]}${f.name ? ` (${f.name})` : ""} ${Math.round(f.distanceM)} m away`,
        weight: structureWeight(f.kind, f.distanceM, q.radiusM),
        tier: "mapped",
        provenance: { source: f.source ?? "Geological map" },
      }));

      const crossing = intersectionsOf(near);
      if (crossing) {
        evidence.push({
          statement: `${crossing.kinds.map((k) => KIND_LABEL[k]).join(" and ")} intersect within ${Math.round(crossing.distanceM)} m`,
          weight: 0.8,
          tier: "mapped",
          provenance: { source: "Geological map" },
        });
      }

      return {
        provider: "map_layers",
        category: "spatial",
        priority: 15,
        data: {
          faults: near.filter((f) => f.kind === "fault").map((f) => ({
            name: f.name, distanceM: Math.round(f.distanceM), source: f.source,
          })),
        },
        evidence,
        confidence: evidence.length ? Math.max(...evidence.map((e) => e.weight)) : 0,
        datasets: [],
      };
    },
  };
}

// ── Terrain ─────────────────────────────────────────────────────────────────
/** Nearest terrain cell to a position, or null when no DEM is in the pack. */
/**
 * The DEM cell describing this point.
 *
 * Indexed rather than scanned — see lib/geo/terrainIndex.ts — and BOUNDED. The
 * old scan returned the nearest cell however far away it was, which with a
 * country-wide grid means it always returns something, including for a point in
 * the middle of the Indian Ocean.
 */
export const TERRAIN_REACH_M = 5_000;

export function terrainAt(cells: PackTerrainCell[], lat: number, lng: number): PackTerrainCell | null {
  return terrainIndexFor(cells).nearest(lat, lng, TERRAIN_REACH_M);
}

const MORPHOLOGY_NOTE: Record<PackTerrainCell["morphology"], string> = {
  ridge: "Ridge crest — outcrop is typically exposed here",
  slope: "Slope — float may have moved downhill from its source",
  valley: "Valley floor — drainage concentrates float from upstream",
  flat: "Flat ground — bedrock is often under cover",
};

/**
 * Terrain provider. Ships DORMANT until a DEM is ingested (§7.7): with no
 * terrain rows it contributes nothing rather than guessing a landform.
 *
 * Terrain is deliberately CONTEXT, not a prospectivity driver on its own —
 * standing on a ridge does not make ground mineralised. It tells the geologist
 * how to read what they see, and modestly adjusts targeting where landform
 * genuinely changes the odds of finding exposure.
 */
export function makeTerrainProvider(data: () => PackData): GeoContextProvider {
  return {
    name: "terrain",
    category: "spatial",
    priority: 25,
    async fetch(q: GeoQuery): Promise<ProviderContribution> {
      const cells = data().terrain;
      if (cells.length === 0) {
        return {
          provider: "terrain", category: "spatial", priority: 25,
          data: {}, evidence: [], confidence: 0, datasets: [],
        };
      }
      const t = terrainAt(cells, q.lat, q.lng);
      if (!t) {
        return {
          provider: "terrain", category: "spatial", priority: 25,
          data: {}, evidence: [], confidence: 0, datasets: [],
        };
      }

      const evidence: EvidenceItem[] = [{
        statement: `${MORPHOLOGY_NOTE[t.morphology]} (${Math.round(t.elevationM)} m, ${Math.round(t.slopeDeg)}° slope)`,
        // Low weight by design: landform is how to look, not proof of what is there.
        weight: 0.3,
        tier: "mapped",
        provenance: { source: "DEM-derived terrain" },
      }];

      if (t.drainageDistM != null && t.drainageDistM < 200) {
        evidence.push({
          statement: `Drainage within ${Math.round(t.drainageDistM)} m — worth panning for indicator minerals`,
          weight: 0.35,
          tier: "mapped",
          provenance: { source: "DEM-derived terrain" },
        });
      }

      return {
        provider: "terrain",
        category: "spatial",
        priority: 25,
        data: {},
        evidence,
        confidence: 0.3,
        datasets: [],
      };
    },
  };
}

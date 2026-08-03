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
import {
  bboxContains,
  bboxPadding,
  haversineM,
  pointToPolylineM,
  type Position,
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
  PackMapFeature,
  PackTerrainCell,
} from "../../../shared/geo-core/pack/types.ts";

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

export interface NearbyFeature {
  id: string;
  kind: MapFeatureKind;
  name: string | null;
  distanceM: number;
  source: string | null;
}

/** Distance from a position to every map feature within the radius, nearest first. */
export function featuresNear(
  features: PackMapFeature[],
  lat: number,
  lng: number,
  radiusM: number,
): NearbyFeature[] {
  const { dLat, dLng } = bboxPadding(lat, radiusM);
  const out: NearbyFeature[] = [];
  for (const f of features) {
    // Cheap bbox rejection first; the polyline test still decides.
    const padded: [number, number, number, number] = [
      f.bbox[0] - dLng, f.bbox[1] - dLat, f.bbox[2] + dLng, f.bbox[3] + dLat,
    ];
    if (!bboxContains(padded, lng, lat)) continue;

    let best = Infinity;
    for (const line of f.lines) {
      const d = pointToPolylineM({ lat, lng }, line as Position[]);
      if (d < best) best = d;
    }
    if (best <= radiusM) {
      out.push({ id: f.id, kind: f.kind, name: f.name, distanceM: best, source: f.source });
    }
  }
  out.sort((a, b) => a.distanceM - b.distanceM);
  return out;
}

/** Proximity falloff: right on a structure is the signal; 5 km away is not. */
function structureWeight(kind: MapFeatureKind, distanceM: number, radiusM: number): number {
  const base = KIND_WEIGHT[kind] ?? 0.15;
  const proximity = Math.max(0, 1 - distanceM / Math.max(radiusM, 1));
  return base * proximity;
}

/**
 * Structural intersections are COMPUTED, not asserted (§7.7).
 *
 * Where a fault and a contact both pass close to the same point, that
 * intersection is a stronger target than either alone — a classic structural
 * trap. Emitting it as its own evidence item is what lets a recommendation say
 * "fault–contact intersection" instead of only "near a fault".
 */
const INTERSECTION_RADIUS_M = 500;

export function intersectionsOf(near: NearbyFeature[]): { kinds: MapFeatureKind[]; distanceM: number } | null {
  const close = near.filter((f) => f.distanceM <= INTERSECTION_RADIUS_M);
  const kinds = [...new Set(close.filter((f) => f.kind === "fault" || f.kind === "contact").map((f) => f.kind))];
  if (kinds.length < 2) return null;
  return { kinds, distanceM: Math.max(...close.filter((f) => kinds.includes(f.kind)).map((f) => f.distanceM)) };
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
export function terrainAt(cells: PackTerrainCell[], lat: number, lng: number): PackTerrainCell | null {
  let best: PackTerrainCell | null = null;
  let bestD = Infinity;
  for (const c of cells) {
    const d = haversineM({ lat, lng }, { lat: c.lat, lng: c.lng });
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
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

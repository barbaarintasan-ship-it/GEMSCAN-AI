// StructuralGeologyProvider (Category A/spatial, priority 15) — EMIE architecture,
// DORMANT by design. It queries geo.structural_feature for faults / shear zones /
// lineaments / fracture zones near the point and, when present, emits proximity
// evidence (structural controls are first-order for many ore systems). Until that
// table is loaded it returns nothing — no remote sensing, no derivation. Wiring it
// now means loading data later needs zero code changes.
import type { GeoContextProvider, GeoQuery, ProviderContribution } from "../types.ts";
import type { GeoDataGateway } from "./gateway.ts";

const TIER = "mapped"; // real mapped structures, when loaded, are proper spatial evidence

function proximityWeight(distanceM: number, radiusM: number): number {
  const w = 1 - distanceM / Math.max(radiusM, 1);
  return Math.max(0.2, Math.min(0.9, w));
}

export function makeStructuralGeologyProvider(gw: GeoDataGateway): GeoContextProvider {
  return {
    name: "structural_geology",
    category: "spatial",
    priority: 15,
    async fetch(q: GeoQuery): Promise<ProviderContribution> {
      const rows = await gw.structuralFeaturesNear(q.lat, q.lng, q.radiusM).catch(() => []);
      const evidence = rows.map((r) => ({
        statement: `${cap(r.feature_type.replace(/_/g, " "))}${r.name ? ` (${r.name})` : ""} mapped ${Math.round(Number(r.distance_m))} m away`,
        weight: proximityWeight(Number(r.distance_m), q.radiusM),
        tier: TIER,
        provenance: { source: "Structural geology dataset", quote: JSON.stringify({ epistemic: "inferred", featureType: r.feature_type, kind: "structure" }) },
      }));
      return {
        provider: "structural_geology",
        category: "spatial",
        priority: 15,
        data: { faults: rows.map((r) => ({ type: r.feature_type, name: r.name, distanceM: Math.round(Number(r.distance_m)) })) },
        evidence,
        confidence: evidence.length ? Math.max(...evidence.map((e) => e.weight)) : 0,
        datasets: rows.length ? [{ source: "Structural geology dataset" }] : [],
      };
    },
  };
}

function cap(s: string): string { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

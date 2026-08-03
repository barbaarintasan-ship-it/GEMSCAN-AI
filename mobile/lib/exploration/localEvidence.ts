// Local evidence overlay — the geologist's own observations (Architecture §9).
//
// Two sources fuse at query time with different trust semantics: the pack is
// read-only published knowledge; this is an append-only record of what the
// person standing there actually saw. Invariant 6 keeps them distinguishable
// all the way to the conclusion — a waypoint never becomes a published
// occurrence, it stays an observation with its own provenance.
//
// Scope decision (§14.3, option b): offline evidence is what the geologist
// DECLARES — the waypoint type they chose. No on-device classification is
// claimed, because none has been assessed. Cloud vision later upgrades an
// observation's tier (§10.3) rather than being needed to create it.
import { haversineM } from "../../../shared/geo-core/geo/spatial.ts";
import type {
  EvidenceItem,
  GeoContextProvider,
  GeoQuery,
  ProviderContribution,
} from "../../../shared/geo-core/types.ts";
import { positionQuality, type Waypoint, type WaypointType } from "../field/waypointTypes";

/** Tier for a geologist-declared observation — strong, and the app says why. */
export const FIELD_OBSERVATION_TIER = "field_observation";

/**
 * How strongly each waypoint type indicates mineralisation.
 *
 * A gossan or visible sulfides is a direct indicator; an outcrop is a place to
 * look, not a find. These weights are what stop "I stood on a rock" scoring
 * like "I found sulfides", which is the difference between a useful assistant
 * and one nobody believes twice.
 */
const TYPE_SIGNAL: Record<WaypointType, number> = {
  sulfides: 0.85,
  gossan: 0.8,
  "quartz-vein": 0.7,
  vein: 0.65,
  alteration: 0.6,
  contact: 0.5,
  fault: 0.5,
  float: 0.45,
  outcrop: 0.3,
  other: 0.2,
};

/** Human-readable label for a type, used in the evidence statement. */
const TYPE_LABEL: Record<WaypointType, string> = {
  sulfides: "Sulfides",
  gossan: "Gossan",
  "quartz-vein": "Quartz vein",
  vein: "Vein",
  alteration: "Alteration",
  contact: "Geological contact",
  fault: "Fault",
  float: "Float",
  outcrop: "Outcrop",
  other: "Observation",
};

export interface Observation {
  id: string;
  type: WaypointType;
  lat: number;
  lng: number;
  distanceM: number;
  /** Evidence weight, already discounted for position quality. */
  weight: number;
  statement: string;
  notes: string;
  capturedAt: number;
}

/** What the targeting engine and the provider both read. */
export interface LocalEvidenceSource {
  observationsNear(lat: number, lng: number, radiusM: number): Observation[];
}

/** Waypoints without a usable position cannot be placed, so they cannot be evidence. */
function toObservation(w: Waypoint, lat: number, lng: number): Observation | null {
  if (!w.position) return null;
  const distanceM = haversineM({ lat, lng }, { lat: w.position.lat, lng: w.position.lng });

  // A degraded or stale fix weakens the observation rather than discarding it:
  // the geologist did see something, we are just less sure exactly where.
  const quality = positionQuality(w.position);
  const qualityFactor =
    quality === "good" ? 1 : quality === "degraded" ? 0.75 : quality === "stale" ? 0.5 : 0;

  const base = TYPE_SIGNAL[w.type] ?? 0.2;
  return {
    id: w.id,
    type: w.type,
    lat: w.position.lat,
    lng: w.position.lng,
    distanceM,
    weight: Math.max(0, Math.min(1, base * qualityFactor)),
    statement: `${TYPE_LABEL[w.type] ?? "Observation"} recorded here${
      quality === "good" ? "" : ` (${quality} position)`
    }`,
    notes: w.notes,
    capturedAt: w.capturedAt,
  };
}

/** Reads live waypoints from the M2.1 store — no second copy of the data. */
export function makeWaypointEvidenceSource(store: {
  visible(sessionId?: string): readonly Waypoint[];
}): LocalEvidenceSource {
  return {
    observationsNear(lat, lng, radiusM) {
      const out: Observation[] = [];
      for (const w of store.visible()) {
        const o = toObservation(w, lat, lng);
        if (o && o.distanceM <= radiusM) out.push(o);
      }
      out.sort((a, b) => a.distanceM - b.distanceM);
      return out;
    },
  };
}

/**
 * A GeoContextProvider over local observations.
 *
 * Appended to the pack providers rather than replacing any of them, so "what is
 * here" includes what the geologist has already found this session, and the
 * confidence model weighs it alongside published knowledge — with the highest
 * priority, because a direct observation outranks a map.
 */
export function makeLocalEvidenceProvider(source: LocalEvidenceSource): GeoContextProvider {
  return {
    name: "local_evidence",
    category: "spatial",
    priority: 5, // ahead of geology (10) and occurrence (20): observation wins
    async fetch(q: GeoQuery): Promise<ProviderContribution> {
      const observations = source.observationsNear(q.lat, q.lng, q.radiusM);
      const evidence: EvidenceItem[] = observations.map((o) => ({
        statement: `${o.statement} — ${Math.round(o.distanceM)} m away`,
        weight: o.weight,
        tier: FIELD_OBSERVATION_TIER,
        provenance: { source: "Field observation" },
        temporal: { observationDate: new Date(o.capturedAt).toISOString() },
      }));

      return {
        provider: "local_evidence",
        category: "spatial",
        priority: 5,
        data: {},
        evidence,
        confidence: observations.length ? Math.max(...observations.map((o) => o.weight)) : 0,
        // No dataset: this is the geologist's own record, not a published source.
        datasets: [],
      };
    },
  };
}

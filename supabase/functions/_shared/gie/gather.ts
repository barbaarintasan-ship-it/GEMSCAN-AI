// GIE stage 1 — GATHER (Sprint 4.3 S2).
//
// Assemble the unified Evidence Set from every available source: the sample's own
// field data + the GeoContext providers (geology/occurrence/knowledge/association/
// community). Pure functions (fieldEvidence/geoEvidence/assemble) are fully unit-
// testable with no DB; runProviders is the thin, failure-isolated orchestration.
// Missing datasets simply contribute nothing and lower confidence downstream —
// no special-casing needed (Principle #5).
import type { EvidenceType, EvidenceNode, EvidenceInput, EvidenceSet, SampleInput } from "./types.ts";
import type { GeoContextProvider, ProviderContribution, GeoQuery } from "../geocontext/types.ts";

// Provider name → evidence type.
const PROVIDER_EV_TYPE: Record<string, EvidenceType> = {
  geology: "spatial",
  occurrence: "occurrence",
  knowledge: "knowledge",
  mineral_association: "association",
  community: "prior_sample",
};

type RawNode = EvidenceInput;

// ── Field evidence (the sample itself) — direct observations ─────────────────
export function fieldEvidence(s: SampleInput): RawNode[] {
  const out: RawNode[] = [];
  const push = (statement: string, statementSo: string, quality: number) =>
    out.push({ source: "field_sample", evType: "field", statement, statementSo, isObservation: true, tier: "field_observation", quality });

  // Location + elevation
  const accPart = s.gpsAccuracyM != null ? ` (±${Math.round(s.gpsAccuracyM)} m)` : "";
  const elevPart = s.altitudeM != null ? `, elevation ${Math.round(s.altitudeM)} m` : "";
  const elevPartSo = s.altitudeM != null ? `, dhererka ${Math.round(s.altitudeM)} m` : "";
  const coords = `${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}`;
  push(`Sample located at ${coords}${accPart}${elevPart}`,
    `Sample-ku wuxuu ku yaal ${coords}${accPart}${elevPartSo}`,
    s.gpsAccuracyM != null && s.gpsAccuracyM <= 10 ? 0.95 : 0.8);

  if (s.terrainType) push(`Terrain: ${s.terrainType}`, `Dhulka: ${s.terrainType}`, 0.7);
  if (s.geologicalEnvironment) push(`Field-recorded geological environment: ${s.geologicalEnvironment}`, `Deegaanka juqraafi ee la duubay: ${s.geologicalEnvironment}`, 0.7);

  // Host rock
  if (s.hostRock?.rockClass?.trim()) {
    const bits = [s.hostRock.texture, s.hostRock.weathering].filter(Boolean).join(", ");
    const suffix = bits ? ` (${bits})` : "";
    push(`Host rock recorded in field: ${s.hostRock.rockClass}${suffix}`, `Dhagaxa martida loo galay: ${s.hostRock.rockClass}${suffix}`, 0.9);
  }
  if (s.hostRock?.notes?.trim()) push(`Host-rock note: ${s.hostRock.notes.trim()}`, `Qoraal dhagax-martigelin: ${s.hostRock.notes.trim()}`, 0.7);

  // Minerals
  for (const m of s.minerals) {
    if (!m.mineral?.trim()) continue;
    push(`Mineral observed in field: ${m.mineral}`, `Macdan goobta laga arkay: ${m.mineral}`, 0.85);
  }

  // Alteration
  if (s.alteration?.alterationType?.trim()) {
    const grade = s.alteration.intensity ? ` (${s.alteration.intensity})` : "";
    push(`Alteration observed: ${s.alteration.alterationType}${grade}`, `Isbeddel la arkay: ${s.alteration.alterationType}${grade}`, 0.85);
  }

  // Structure
  for (const st of s.structural) {
    if (!st.structureType?.trim()) continue;
    const orient = st.strikeDeg != null && st.dipDeg != null ? ` ${Math.round(st.strikeDeg)}/${Math.round(st.dipDeg)}` : "";
    push(`Structure measured: ${st.structureType}${orient}`, `Qaab-dhismeed la cabiray: ${st.structureType}${orient}`, 0.85);
  }

  // Free-text field note (observation, but lower quality as evidence)
  if (s.fieldObservations?.trim()) push(`Field note: ${s.fieldObservations.trim()}`, `Qoraal goobeed: ${s.fieldObservations.trim()}`, 0.6);

  return out;
}

// ── Geo evidence (GeoContext provider contributions) — mostly derived ────────
export function geoEvidence(contributions: ProviderContribution[]): RawNode[] {
  const out: RawNode[] = [];
  for (const c of contributions) {
    const evType = PROVIDER_EV_TYPE[c.provider] ?? "knowledge";
    const datasetId = c.datasets?.find((d) => d.datasetId)?.datasetId;
    for (const item of c.evidence) {
      out.push({
        source: c.provider,
        evType,
        statement: item.statement,
        isObservation: false, // provider-derived spatial/knowledge inference
        tier: item.tier,
        quality: clamp01(item.weight),
        datasetId,
        provenance: item.provenance as Record<string, unknown> | undefined,
      });
    }
  }
  return out;
}

// ── Assemble: assign stable ids (e1, e2, …) and tally ────────────────────────
export function assemble(raw: RawNode[], providersRun: string[], providersFailed: string[]): EvidenceSet {
  const nodes: EvidenceNode[] = raw.map((n, i) => ({ ...n, id: `e${i + 1}` }));
  const countsByType = { field: 0, visual: 0, spatial: 0, occurrence: 0, knowledge: 0, association: 0, prior_sample: 0 } as Record<EvidenceType, number>;
  for (const n of nodes) countsByType[n.evType]++;
  return { nodes, providersRun, providersFailed, countsByType };
}

// Combine field + geo into one Evidence Set (field first — observations lead).
export function gather(sample: SampleInput, contributions: ProviderContribution[],
  providersRun: string[], providersFailed: string[]): EvidenceSet {
  return assemble([...fieldEvidence(sample), ...geoEvidence(contributions)], providersRun, providersFailed);
}

// ── Provider orchestration (parallel, timeout-guarded, failures isolated) ────
// Mirrors GeoContextEngine's discipline: one slow/failed provider degrades
// gracefully instead of failing the whole gather.
export async function runProviders(
  providers: GeoContextProvider[],
  query: GeoQuery,
  timeoutMs = 8000,
): Promise<{ contributions: ProviderContribution[]; providersRun: string[]; providersFailed: string[] }> {
  const settled = await Promise.allSettled(
    providers.map((p) => withTimeout(p.fetch(query), timeoutMs)),
  );
  const contributions: ProviderContribution[] = [];
  const providersRun: string[] = [];
  const providersFailed: string[] = [];
  settled.forEach((r, i) => {
    const p = providers[i];
    if (r.status === "fulfilled") {
      contributions.push(r.value);
      providersRun.push(p.name);
    } else {
      providersFailed.push(p.name);
    }
  });
  return { contributions, providersRun, providersFailed };
}

function withTimeout<T>(pr: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("provider timeout")), ms);
    pr.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}

// Shadow-mode divergence (Architecture §11.1, Stage E3).
//
// Before a device-computed answer is ever shown to a geologist, it runs beside
// the server's answer for the same query and every disagreement is recorded.
// Unit tests prove the port compiles and behaves on fixtures; only divergence
// data proves it AGREES on real ground.
//
// Tolerances come straight from the approved spec:
//   distance to an occurrence   ≤ 0.5%   (geodesy, §7.4)
//   confidence score            ≤ 0.01 absolute
//   evidence set membership     EXACT
//   provider contribution order EXACT
//
// Membership is deliberately zero-tolerance: a differing set means the two
// systems are reasoning over different worlds, which no confidence tolerance
// can excuse.
import type { GeoContext } from "../types.ts";

export interface DivergenceTolerances {
  /** Fractional, e.g. 0.005 = 0.5%. */
  distanceRelative: number;
  /**
   * Differences below this many metres are never reported, whatever the
   * percentage. Close to an occurrence a relative test degenerates: 0.2 m
   * apart at 1 m distance is 20%, which would bury a shadow-mode run in
   * divergences for occurrences the geologist is effectively standing on,
   * while meaning nothing geologically.
   */
  distanceFloorM: number;
  /** Absolute, on the 0..1 confidence score. */
  confidenceAbsolute: number;
}

export const DEFAULT_TOLERANCES: DivergenceTolerances = {
  distanceRelative: 0.005,
  distanceFloorM: 1,
  confidenceAbsolute: 0.01,
};

export type DivergenceKind =
  | "geology-unit"
  | "provider-order"
  | "provider-failed"
  | "evidence-membership"
  | "occurrence-distance"
  | "confidence-score"
  | "confidence-band"
  | "dataset-set";

export interface Divergence {
  kind: DivergenceKind;
  /** True when this breaches a zero-tolerance rule rather than a numeric bound. */
  exact: boolean;
  device: string;
  server: string;
  detail?: string;
}

export interface DivergenceReport {
  ok: boolean;
  h3?: string;
  lat: number;
  lng: number;
  divergences: Divergence[];
}

/** Stable identity for an occurrence, independent of the distance we are testing. */
function occurrenceKey(o: Record<string, unknown>): string {
  return [o.commodity ?? "", o.depositType ?? "", o.source ?? "", o.reference ?? ""].join("|");
}

function sortedKeys(rows: Array<Record<string, unknown>>): string[] {
  return rows.map(occurrenceKey).sort();
}

/**
 * Compare a device-computed GeoContext against the server's for the same query.
 *
 * Returns every disagreement rather than the first, because triage needs the
 * whole picture: one geodesy-driven distance difference is expected, while a
 * membership difference alongside it means something else is wrong.
 */
export function compareContexts(
  device: GeoContext,
  server: GeoContext,
  tolerances: DivergenceTolerances = DEFAULT_TOLERANCES,
): DivergenceReport {
  const divergences: Divergence[] = [];

  // What is under the geologist's feet — exact.
  const dUnit = device.geology?.unit ?? "";
  const sUnit = server.geology?.unit ?? "";
  if (dUnit !== sUnit) {
    divergences.push({ kind: "geology-unit", exact: true, device: dUnit || "(none)", server: sUnit || "(none)" });
  }

  // Provider contribution ordering — exact.
  const dRun = device.meta.providersRun.join(",");
  const sRun = server.meta.providersRun.join(",");
  if (dRun !== sRun) {
    divergences.push({ kind: "provider-order", exact: true, device: dRun, server: sRun });
  }

  // A provider failing on one side only is a real defect, not a tolerance case.
  const dFailed = [...device.meta.providersFailed].sort().join(",");
  const sFailed = [...server.meta.providersFailed].sort().join(",");
  if (dFailed !== sFailed) {
    divergences.push({ kind: "provider-failed", exact: true, device: dFailed || "(none)", server: sFailed || "(none)" });
  }

  // Evidence set membership — exact.
  const dKeys = sortedKeys(device.knownOccurrences ?? []);
  const sKeys = sortedKeys(server.knownOccurrences ?? []);
  if (dKeys.join(";") !== sKeys.join(";")) {
    const onlyDevice = dKeys.filter((k) => !sKeys.includes(k));
    const onlyServer = sKeys.filter((k) => !dKeys.includes(k));
    divergences.push({
      kind: "evidence-membership",
      exact: true,
      device: `${dKeys.length} occurrences`,
      server: `${sKeys.length} occurrences`,
      detail: `only-device: [${onlyDevice.join(", ")}] only-server: [${onlyServer.join(", ")}]`,
    });
  } else {
    // Same set ⇒ distances are comparable pairwise. This is the geodesy check.
    const sByKey = new Map((server.knownOccurrences ?? []).map((o) => [occurrenceKey(o), o]));
    for (const d of device.knownOccurrences ?? []) {
      const s = sByKey.get(occurrenceKey(d));
      if (!s) continue;
      const dm = Number(d.distanceM ?? 0);
      const sm = Number(s.distanceM ?? 0);
      const absDiff = Math.abs(dm - sm);
      const denom = Math.max(Math.abs(sm), 1); // a 0 m server distance cannot scale
      const rel = absDiff / denom;
      // Must breach BOTH: a large percentage of a tiny distance is not a defect.
      if (rel > tolerances.distanceRelative && absDiff > tolerances.distanceFloorM) {
        divergences.push({
          kind: "occurrence-distance",
          exact: false,
          device: `${dm.toFixed(1)} m`,
          server: `${sm.toFixed(1)} m`,
          detail: `${(rel * 100).toFixed(3)}% (${absDiff.toFixed(2)} m) > ${(tolerances.distanceRelative * 100).toFixed(3)}% — ${occurrenceKey(d)}`,
        });
      }
    }
  }

  // Confidence — numeric tolerance on the score, exact on the band it produces.
  const dScore = device.confidence.score;
  const sScore = server.confidence.score;
  if (Math.abs(dScore - sScore) > tolerances.confidenceAbsolute) {
    divergences.push({
      kind: "confidence-score",
      exact: false,
      device: dScore.toFixed(4),
      server: sScore.toFixed(4),
      detail: `|Δ| ${Math.abs(dScore - sScore).toFixed(4)} > ${tolerances.confidenceAbsolute}`,
    });
  }
  if (device.confidence.overall !== server.confidence.overall) {
    // Two answers landing in different bands is user-visible, whatever the delta.
    divergences.push({
      kind: "confidence-band",
      exact: true,
      device: device.confidence.overall,
      server: server.confidence.overall,
    });
  }

  // The datasets each side says it drew on — exact.
  const dsKey = (ctx: GeoContext) =>
    [...(ctx.evidence?.datasets ?? [])]
      .map((d) => `${d.source}|${d.version ?? ""}`)
      .sort()
      .join(";");
  if (dsKey(device) !== dsKey(server)) {
    divergences.push({ kind: "dataset-set", exact: true, device: dsKey(device), server: dsKey(server) });
  }

  return {
    ok: divergences.length === 0,
    h3: device.location.h3,
    lat: device.location.lat,
    lng: device.location.lng,
    divergences,
  };
}

/** One-line-per-divergence summary for the shadow-mode log. */
export function formatReport(r: DivergenceReport): string {
  if (r.ok) return `MATCH ${r.lat.toFixed(5)},${r.lng.toFixed(5)}${r.h3 ? ` (${r.h3})` : ""}`;
  const lines = r.divergences.map(
    (d) => `  ${d.exact ? "EXACT" : "TOL  "} ${d.kind}: device=${d.device} server=${d.server}${d.detail ? ` — ${d.detail}` : ""}`,
  );
  return [`DIVERGE ${r.lat.toFixed(5)},${r.lng.toFixed(5)}${r.h3 ? ` (${r.h3})` : ""}`, ...lines].join("\n");
}

/** Aggregate across a shadow-mode run — what E3's exit criterion is judged on. */
export function summarise(reports: DivergenceReport[]): {
  total: number;
  matched: number;
  byKind: Record<string, number>;
  exactBreaches: number;
} {
  const byKind: Record<string, number> = {};
  let matched = 0;
  let exactBreaches = 0;
  for (const r of reports) {
    if (r.ok) matched++;
    for (const d of r.divergences) {
      byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
      if (d.exact) exactBreaches++;
    }
  }
  return { total: reports.length, matched, byKind, exactBreaches };
}

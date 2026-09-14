// Phase 4 (Solo→Team shared-targeting) — pure cell-grouping/ranking logic.
//
// Deliberately its OWN module with zero imports: `groupMissionCells` has
// real logic worth unit-testing directly (grouping, ranking, tie-breaking),
// and every other file in lib/enterprise/ transitively imports ../supabase,
// which throws at module-load time if EXPO_PUBLIC_SUPABASE_URL/ANON_KEY
// aren't set — exactly the env-var guard that makes missions.ts itself
// untestable by direct import (see missionProgressRollup.test.ts's own note
// on why it uses source-pattern matching instead). Keeping this function
// import-free means it can be unit-tested like any other pure function,
// with no environment setup at all.
import type { Assignment, MissionCellGroup } from "./missions";

export type { MissionCellGroup };

/**
 * Groups the flat `fetchMissionAssignments()` result back into one entry per
 * H3 cell, then ranks the GROUPS — never individual assignment rows — by
 * `prospectivityScore` (nulls last), tie-broken by `target_h3` itself
 * (stable, always distinct; same spirit as Solo's `rank()` tie-break —
 * nearer wins — just the nearest deterministic equivalent available at this
 * granularity, not a new geological weighting invented for ties).
 *
 * A cell with zero contributors still gets a group (`contributors: []`) —
 * "ranked, nobody assigned yet" is the whole point of Phase 3/4 keeping
 * intelligence and assignment separate.
 */
export function groupMissionCells(rows: Assignment[]): MissionCellGroup[] {
  const byCell = new Map<string, MissionCellGroup>();
  for (const row of rows) {
    let group = byCell.get(row.target_h3);
    if (!group) {
      group = {
        targetH3: row.target_h3, cellId: "", areaId: null,
        prospectivityScore: null, scoredAt: null,
        integratedScore: null, evidenceSampleCount: 0, contributors: [],
      };
      byCell.set(row.target_h3, group);
    }
    if (row.contributor_id == null) {
      group.cellId = row.id;
      group.areaId = row.area_id;
      group.prospectivityScore = row.prospectivity_score;
      group.scoredAt = row.scored_at;
      group.integratedScore = row.integrated_score;
      group.evidenceSampleCount = row.evidence_sample_count ?? 0;
    } else {
      group.contributors.push(row);
    }
  }
  const groups = [...byCell.values()];
  groups.sort((a, b) => {
    const sa = a.prospectivityScore, sb = b.prospectivityScore;
    if (sa == null && sb == null) return a.targetH3.localeCompare(b.targetH3);
    if (sa == null) return 1;
    if (sb == null) return -1;
    if (sb !== sa) return sb - sa;
    return a.targetH3.localeCompare(b.targetH3);
  });
  return groups;
}

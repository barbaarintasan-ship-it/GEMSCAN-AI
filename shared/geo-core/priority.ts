// GeoContext runtime — provider priority & conflict resolution (Architecture §9a).
//
// Priority decides the winning VALUE on a direct conflict (mutually-exclusive
// scalar). It is NOT confidence — evidence_tier still sets weight. The losing
// value is retained as an alternative, never silently dropped. Precedence is
// configurable (a constant here; may later come from enterprise.config_entry
// namespace 'geocontext.priority').
//
// Lower rank = higher priority.
export const DEFAULT_PROVIDER_PRIORITY: Record<string, number> = {
  geology: 10, // UNESCO mapped GIS
  occurrence: 20, // MRDS
  knowledge: 30, // IAEA / Greenwood / GEOSOM / UNDP (extracted)
  mineral_association: 40,
  community: 50,
};

export function priorityOf(
  provider: string,
  table: Record<string, number> = DEFAULT_PROVIDER_PRIORITY,
): number {
  return table[provider] ?? 100; // unknown providers sort last
}

export interface Ranked<T> {
  value: T;
  source: string;
  priority: number;
}

// Resolve a scalar conflict: highest-priority (lowest rank) wins; the rest become
// alternatives (deduped by value, winner excluded).
export function resolveConflict<T>(
  candidates: Ranked<T>[],
): { value: T; source: string; alternatives: Array<{ value: T; source: string }> } | null {
  const present = candidates.filter((c) => c.value !== undefined && c.value !== null && c.value !== "");
  if (present.length === 0) return null;
  const sorted = [...present].sort((a, b) => a.priority - b.priority);
  const winner = sorted[0];
  const alternatives = sorted
    .slice(1)
    .filter((c) => c.value !== winner.value)
    .map((c) => ({ value: c.value, source: c.source }));
  return { value: winner.value, source: winner.source, alternatives };
}

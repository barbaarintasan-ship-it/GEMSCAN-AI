// My Sample Collection, offline.
//
// The collection was a network read: no signal, no collection — an empty screen
// or an error, over samples the geologist had taken with their own hands an hour
// earlier. That is the wrong answer twice over, because the device holds every
// one of them.
//
// So the list is assembled from two sources and never fails:
//
//   LOCAL   samples this device created (localSampleStore) — the ones still
//           waiting to be filed, and the ones already filed, kept as a cache.
//   CACHED  the last server list that was successfully read, written to storage
//           so it survives a restart.
//
// DE-DUPLICATION is the whole difficulty, and it is solved by identity rather
// than by guessing: a local sample that has been accepted knows its `serverId`,
// so when the server row for it appears the two are the same row and the SERVER
// version wins — it carries the analysis. A local sample with no serverId cannot
// possibly be in the server list, so it is shown as its own entry.
import type { SampleListRow } from "../enterpriseSamples";
import type { LocalSample, LocalSampleStore, KeyValueAdapter } from "./localSampleStore";

export const SAMPLE_LIST_CACHE_KEY = "enterprise.samples.cache.v1";

/** A row for the collection screen: from the server, from here, or both. */
export interface CollectionRow extends SampleListRow {
  /** Present when this device created it — the local record's id. */
  localId?: string;
  /** Where it is: filed with the server, or still held here. */
  local?: {
    state: LocalSample["state"];
    aiState: LocalSample["aiState"];
    photoCount: number;
    lastError: string | null;
  };
}

interface CacheEnvelope {
  version: 1;
  fetchedAt: number;
  rows: SampleListRow[];
}

/** A pending sample rendered as a collection row, so one list shows everything. */
export function rowFromLocal(s: LocalSample): CollectionRow {
  return {
    // The local id stands in for the server id until there is one. Screens key
    // on this, so it must be stable and unique — which it is.
    id: s.serverId ?? s.localId,
    localId: s.localId,
    name: s.payload.name ?? null,
    collected_at: s.payload.collected_at ?? new Date(s.createdAt).toISOString(),
    // Not "submitted": it is not with the server yet, and saying otherwise would
    // be the app claiming something it has not done.
    status: s.state === "uploaded" ? "submitted" : "held_on_device",
    completeness_status: null,
    completeness_score: null,
    ai_confidence: null,
    // NOT s.lastError. That is why an offline sample read as "Network request
    // failed": a queued upload is not a failed ANALYSIS, and ai_error is
    // rendered as one. The upload's own error stays in `local.lastError`, where
    // it is shown as "will retry".
    ai_error: null,
    ai_attempted_at: null,
    geologist_confidence: null,
    confidence_score: null,
    local: {
      state: s.state,
      aiState: s.aiState,
      photoCount: s.photos.length,
      lastError: s.lastError,
    },
  } as CollectionRow;
}

/**
 * Merge the two sources into one collection, newest first.
 *
 * The server row wins wherever both exist, because it carries the analysis — but
 * it keeps the local marks, so the screen can still say "this one is yours and
 * it is filed".
 */
export function mergeCollection(
  serverRows: readonly SampleListRow[],
  locals: readonly LocalSample[],
): CollectionRow[] {
  const byServerId = new Map<string, LocalSample>();
  for (const l of locals) if (l.serverId) byServerId.set(l.serverId, l);

  const out: CollectionRow[] = serverRows.map((r) => {
    const l = byServerId.get(r.id);
    return l ? { ...r, localId: l.localId, local: rowFromLocal(l).local } : { ...r };
  });

  const seen = new Set(serverRows.map((r) => r.id));
  for (const l of locals) {
    // Already represented by its server row.
    if (l.serverId && seen.has(l.serverId)) continue;
    out.push(rowFromLocal(l));
  }

  return out.sort((a, b) => (b.collected_at ?? "").localeCompare(a.collected_at ?? ""));
}

export interface CollectionResult {
  rows: CollectionRow[];
  /** True when the server could not be read and this came from the cache. */
  fromCache: boolean;
  /** When the cached server list was last refreshed. */
  fetchedAt: number | null;
}

/**
 * The collection, however the network is behaving.
 *
 * Never throws. A failed read is not an error to show a geologist standing over
 * an outcrop; it is a reason to show what the device already knows.
 */
export async function loadCollection(
  store: LocalSampleStore,
  storage: KeyValueAdapter,
  deps: { list: () => Promise<SampleListRow[]> },
): Promise<CollectionResult> {
  await store.load();
  const locals = store.all();

  let cached: CacheEnvelope | null = null;
  try {
    const raw = await storage.getItem(SAMPLE_LIST_CACHE_KEY);
    if (raw) {
      const env = JSON.parse(raw) as CacheEnvelope;
      if (env?.version === 1 && Array.isArray(env.rows)) cached = env;
    }
  } catch {
    // A corrupt cache is the same as no cache.
  }

  try {
    const rows = await deps.list();
    const env: CacheEnvelope = { version: 1, fetchedAt: Date.now(), rows };
    // Written before returning, so the next offline read has it.
    await storage.setItem(SAMPLE_LIST_CACHE_KEY, JSON.stringify(env)).catch(() => {});
    return { rows: mergeCollection(rows, locals), fromCache: false, fetchedAt: env.fetchedAt };
  } catch {
    return {
      rows: mergeCollection(cached?.rows ?? [], locals),
      fromCache: true,
      fetchedAt: cached?.fetchedAt ?? null,
    };
  }
}

/** Search over the assembled collection — name, status and id, case-insensitive. */
export function searchCollection(rows: readonly CollectionRow[], query: string): CollectionRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter((r) =>
    (r.name ?? "").toLowerCase().includes(q) ||
    r.status.toLowerCase().includes(q) ||
    r.id.toLowerCase().includes(q) ||
    (r.localId ?? "").toLowerCase().includes(q),
  );
}

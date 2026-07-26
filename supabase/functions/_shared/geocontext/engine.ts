// GeoContext runtime — engine orchestration (Architecture §7).
//
// run(query): cache check → PARALLEL provider execution (timeout-guarded, failures
// isolated) → evidence fusion → confidence → assemble GeoContext JSON → write-through
// cache. Never calls an LLM. A slow/failed provider degrades gracefully (its
// contribution is omitted and confidence is lowered), it never fails the request.

import { computeConfidence } from "./confidence.ts";
import { fuse } from "./fusion.ts";
import type {
  CacheStore,
  DatasetRef,
  EvidenceReport,
  GeoContext,
  GeoContextProvider,
  GeoQuery,
  ProviderContribution,
  ProviderEvidence,
} from "./types.ts";

export interface EngineOptions {
  engineVersion: string;
  providers: GeoContextProvider[];
  cache?: CacheStore;
  cacheTtlSeconds?: number;
  providerTimeoutMs?: number;
  now?: () => Date; // injectable clock for tests
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("provider timeout")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export class GeoContextEngine {
  constructor(private readonly opts: EngineOptions) {}

  async run(query: GeoQuery): Promise<GeoContext> {
    const now = this.opts.now ?? (() => new Date());
    const timeout = this.opts.providerTimeoutMs ?? 8000;

    // 1. Cache check (only when we have a stable cell key).
    if (this.opts.cache && query.h3) {
      const hit = await this.opts.cache.get(query.h3, this.opts.engineVersion);
      if (hit) return { ...hit, meta: { ...hit.meta, cache: "hit" } };
    }

    // 2. Parallel providers, failures isolated.
    const results = await Promise.allSettled(
      this.opts.providers.map((p) => withTimeout(p.fetch(query), timeout)),
    );
    const contributions: ProviderContribution[] = [];
    const providersRun: string[] = [];
    const providersFailed: string[] = [];
    const providerEvidence: ProviderEvidence[] = [];
    results.forEach((r, i) => {
      const p = this.opts.providers[i];
      if (r.status === "fulfilled") {
        contributions.push(r.value);
        providersRun.push(p.name);
        const contributed = r.value.evidence.length > 0 || Object.keys(r.value.data).length > 0;
        providerEvidence.push({
          provider: p.name, category: p.category, contributed,
          confidence: r.value.confidence, evidenceCount: r.value.evidence.length,
          datasets: r.value.datasets ?? [],
        });
      } else {
        providersFailed.push(p.name);
        providerEvidence.push({
          provider: p.name, category: p.category, contributed: false,
          confidence: 0, evidenceCount: 0, datasets: [],
          error: (r.reason as Error)?.message ?? "provider error",
        });
      }
    });

    // 3. Fusion + 4. Confidence.
    const fused = fuse(contributions);
    const byProvider: Record<string, number> = {};
    for (const c of contributions) byProvider[c.provider] = c.confidence;
    const confidence = computeConfidence(fused.evidence, { byProvider, providersRun, providersFailed });

    // Explainability: union of all datasets/versions behind the conclusion.
    const seen = new Set<string>();
    const datasetUnion: DatasetRef[] = [];
    for (const pe of providerEvidence) {
      for (const d of pe.datasets) {
        const key = `${d.datasetId ?? ""}|${d.source}|${d.version ?? ""}`;
        if (!seen.has(key)) { seen.add(key); datasetUnion.push(d); }
      }
    }
    const evidence: EvidenceReport = { providers: providerEvidence, datasets: datasetUnion };

    // 5. Assemble GeoContext JSON.
    const ctx: GeoContext = {
      location: { lat: query.lat, lng: query.lng, h3: query.h3 },
      ...fused.data,
      reasoningFactors: fused.reasoningFactors,
      evidence,
      confidence,
      meta: {
        engineVersion: this.opts.engineVersion,
        generatedAt: now().toISOString(),
        providersRun,
        providersFailed,
        cache: "miss",
      },
    };

    // 6. Write-through cache.
    if (this.opts.cache && query.h3) {
      try { await this.opts.cache.set(query.h3, this.opts.engineVersion, ctx, this.opts.cacheTtlSeconds); }
      catch { /* cache write failures never fail the request */ }
    }
    return ctx;
  }
}

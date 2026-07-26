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
  GeoContext,
  GeoContextProvider,
  GeoQuery,
  ProviderContribution,
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
    results.forEach((r, i) => {
      const name = this.opts.providers[i].name;
      if (r.status === "fulfilled") { contributions.push(r.value); providersRun.push(name); }
      else providersFailed.push(name);
    });

    // 3. Fusion + 4. Confidence.
    const fused = fuse(contributions);
    const byProvider: Record<string, number> = {};
    for (const c of contributions) byProvider[c.provider] = c.confidence;
    const confidence = computeConfidence(fused.evidence, { byProvider, providersRun, providersFailed });

    // 5. Assemble GeoContext JSON.
    const ctx: GeoContext = {
      location: { lat: query.lat, lng: query.lng, h3: query.h3 },
      ...fused.data,
      reasoningFactors: fused.reasoningFactors,
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

// Pack store — install, verify, activate (Architecture §7.5, Stage E2).
//
// Invariant 6: "a pack that fails integrity verification is refused, not
// degraded." So this never returns partially-valid data. It is either holding a
// verified pack, or it is holding nothing and says so — and the app then states
// it has no knowledge here rather than extrapolating (§3.9).
//
// The pack SOURCE is injected. E2 reads the pack bundled in the app; E6 adds a
// downloaded-pack source with atomic swap and rollback. Neither this class nor
// its callers change when that lands.
import { emptyPackData, readPack, type LoadedPack } from "../../../shared/geo-core/pack/read.ts";
import {
  describeFailure,
  verifyPack,
  type VerifyFailure,
} from "../../../shared/geo-core/pack/verify.ts";
import type { PackData, PackManifest } from "../../../shared/geo-core/pack/types.ts";

/** Engine-version range this build of the app understands (§7.2). */
export const SUPPORTED_ENGINE_VERSIONS = { min: "1.0.0", max: "1.99.99" };

/** A source of raw pack files: filename → exact content. */
export interface PackSource {
  readonly name: string;
  load(): Promise<Record<string, string> | null>;
}

export type PackStatus =
  | { state: "empty" }                                        // nothing installed yet
  | { state: "ready"; manifest: PackManifest; ageDays: number }
  | { state: "refused"; failure: VerifyFailure; reason: string };

/** Beyond this a pack is old enough that guidance should say so (§3.9). */
export const PACK_STALE_DAYS = 180;

export class PackStore {
  private data: PackData = emptyPackData();
  private manifest: PackManifest | null = null;
  private status: PackStatus = { state: "empty" };
  private loading: Promise<PackStatus> | null = null;

  constructor(
    private readonly source: PackSource,
    private readonly now: () => number = Date.now,
  ) {}

  /** Idempotent and concurrency-safe: parallel callers share one load. */
  async load(): Promise<PackStatus> {
    if (this.status.state !== "empty" || this.loading) {
      return this.loading ?? this.status;
    }
    this.loading = this.doLoad().finally(() => { this.loading = null; });
    return this.loading;
  }

  private async doLoad(): Promise<PackStatus> {
    let files: Record<string, string> | null;
    try {
      files = await this.source.load();
    } catch {
      // A source that throws is indistinguishable from no pack: both mean we
      // have no knowledge, which is a legitimate state, not an error to raise
      // into a field screen.
      files = null;
    }
    if (!files) {
      this.status = { state: "empty" };
      return this.status;
    }

    const verdict = verifyPack(files, { supportedEngineVersions: SUPPORTED_ENGINE_VERSIONS });
    if (!verdict.ok) {
      // Refused: the previous data (empty here) stays in place. Nothing from an
      // unverified pack is ever read.
      this.status = {
        state: "refused",
        failure: verdict.failure,
        reason: describeFailure(verdict.failure),
      };
      return this.status;
    }

    const loaded: LoadedPack = readPack(files);
    this.data = loaded.data;
    this.manifest = loaded.manifest;
    this.status = {
      state: "ready",
      manifest: loaded.manifest,
      ageDays: this.ageDays(loaded.manifest),
    };
    return this.status;
  }

  private ageDays(m: PackManifest): number {
    const built = Date.parse(m.builtAt);
    if (!Number.isFinite(built)) return 0;
    return Math.max(0, Math.floor((this.now() - built) / 86_400_000));
  }

  getStatus(): PackStatus { return this.status; }
  /** Empty until a pack has been verified — never partially-populated. */
  getData(): PackData { return this.data; }
  getManifest(): PackManifest | null { return this.manifest; }
  isReady(): boolean { return this.status.state === "ready"; }

  /**
   * Provenance for every recommendation built from this pack (§3.9, risk 3):
   * a geologist must be able to see how old the knowledge guiding them is.
   */
  provenance(): { packVersion: string; builtAt: string; ageDays: number; stale: boolean } | null {
    if (this.status.state !== "ready") return null;
    return {
      packVersion: this.status.manifest.packVersion,
      builtAt: this.status.manifest.builtAt,
      ageDays: this.status.ageDays,
      stale: this.status.ageDays > PACK_STALE_DAYS,
    };
  }
}

/**
 * The pack shipped inside the app bundle. Trusted by provenance — it arrived in
 * the signed APK — but still verified, because a build-time packaging mistake is
 * exactly as harmful as a tampered download.
 *
 * `require` of a JSON asset is resolved by Metro at build time; a missing pack
 * is a normal state (the app simply has no knowledge yet), not a crash.
 */
export function createBundledPackSource(
  loader: () => Record<string, string> | null,
): PackSource {
  return {
    name: "bundled",
    load: async () => loader(),
  };
}

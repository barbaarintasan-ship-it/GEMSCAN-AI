// TEMPORARY runtime crash instrumentation for the device-specific "Preparing
// photos" crash investigation (e.g. U25 Pro tablet). Everything here is
// OBSERVATIONAL ONLY — it logs; it never alters control flow, image quality,
// AI requests, navigation, or UI. Remove this file and its imports once the
// runtime cause is confirmed.
//
// Two channels:
//   1) slog / enter / exit — timestamped ENTER/EXIT breadcrumbs. The LAST line
//      printed before the process dies pinpoints the failing statement in
//      Android logcat.
//   2) installCrashDiagnostics() — a CHAINED global handler for uncaught JS
//      errors + unhandled promise rejections (native errors surfaced to JS flow
//      through the same global handler). It delegates to the previous handler,
//      so the app's existing crash/reporting behavior is unchanged.
//
// KEY DIAGNOSTIC NUANCE: a genuine NATIVE OutOfMemory / kernel Low-Memory-Killer
// SIGKILL bypasses JS entirely. So if the app dies during "Preparing photos"
// with NO "GLOBAL ..." or "UNHANDLED ..." line printed just before, that ABSENCE
// is itself evidence of a native/kernel kill rather than a JS-level fault.

import * as FileSystem from "expo-file-system";

const TAG = "scan-prep";

function ts(): string {
  // ISO timestamp with millisecond precision — lets us measure the gap between
  // the last EXIT and the crash, and how long a decode/upload step took.
  return new Date().toISOString();
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// Best-effort memory snapshot for one point in the pipeline.
//
// IMPORTANT INTERPRETATION NOTE: Hermes JS-heap stats do NOT include native
// bitmap / graphics memory. A large Glide bitmap (the suspected OOM driver)
// lives in NATIVE memory and is INVISIBLE here — so a flat `jsHeap` across an
// ImageManipulator call is EXPECTED and does NOT disprove a native OOM. Use
// jsHeap only to detect a JS-SIDE leak (retained base64 strings / ArrayBuffers:
// those WOULD show up). For true process RSS (the number that answers the
// bitmap leak-vs-spike question), sample `adb shell dumpsys meminfo
// com.gemscan.ai` during the run — no JS API exposes RSS without a native
// module, and none is installed.
export function mem(label: string): void {
  const parts: string[] = [];
  try {
    const hi = (global as unknown as {
      HermesInternal?: { getInstrumentedStats?: () => Record<string, unknown> };
    }).HermesInternal;
    const stats = hi?.getInstrumentedStats?.();
    if (stats) {
      const pick = (k: string) => (typeof stats[k] === "number" ? (stats[k] as number) : undefined);
      const alloc = pick("js_allocatedBytes");
      const heap = pick("js_heapSize");
      const malloc = pick("js_mallocSizeEstimate");
      if (alloc !== undefined) parts.push(`jsAlloc=${mb(alloc)}`);
      if (heap !== undefined) parts.push(`jsHeap=${mb(heap)}`);
      if (malloc !== undefined) parts.push(`jsMalloc=${mb(malloc)}`);
    }
  } catch {
    /* stats unavailable — fall through to n/a */
  }
  if (parts.length === 0) parts.push("jsHeap=n/a");
  parts.push("rss=n/a(adb dumpsys meminfo)");
  slog(`MEM ${label} — ${parts.join(" ")}`);
}

// Cheap file size (bytes → MB string) with NO image decode — safe to call while
// profiling memory. Returns "n/a" on any error.
export async function fileSizeMB(uri: string): Promise<string> {
  try {
    const info = (await FileSystem.getInfoAsync(uri, { size: true })) as { exists: boolean; size?: number };
    return info.exists && typeof info.size === "number" ? mb(info.size) : "n/a";
  } catch {
    return "n/a";
  }
}

export function slog(msg: string): void {
  console.log(`[${TAG} ${ts()}] ${msg}`);
}

export function enter(name: string): void {
  slog(`ENTER ${name}`);
}

export function exit(name: string): void {
  slog(`EXIT  ${name}`);
}

let installed = false;

export function installCrashDiagnostics(): void {
  if (installed) return;
  installed = true;

  const g = global as unknown as {
    ErrorUtils?: {
      getGlobalHandler?: () => ((e: unknown, isFatal?: boolean) => void) | undefined;
      setGlobalHandler?: (h: (e: unknown, isFatal?: boolean) => void) => void;
    };
    HermesInternal?: {
      enablePromiseRejectionTracker?: (opts: unknown) => void;
    };
  };

  // (1) Uncaught JS + native-surfaced-to-JS exceptions. Chain to the existing
  // handler so the app's crash/reporting behavior is UNCHANGED — observe, then
  // delegate.
  try {
    const prev = g.ErrorUtils?.getGlobalHandler?.();
    g.ErrorUtils?.setGlobalHandler?.((error: unknown, isFatal?: boolean) => {
      const e = error as Error | undefined;
      slog(`GLOBAL ${isFatal ? "FATAL" : "non-fatal"} error: ${e?.name}: ${e?.message}`);
      if (e?.stack) slog(`GLOBAL stack: ${String(e.stack).slice(0, 1000)}`);
      prev?.(error, isFatal);
    });
  } catch (e) {
    slog(`could not install global error handler: ${(e as Error)?.message}`);
  }

  // (2) Unhandled promise rejections. This app runs on Hermes, whose own
  // rejection tracker is the correct hook; fall back to the `promise` polyfill
  // on JSC. Logging only — no rethrow, no behavior change.
  try {
    const onUnhandled = (id: number, error: unknown) => {
      const e = error as Error | undefined;
      slog(`UNHANDLED rejection #${id}: ${e?.name}: ${e?.message ?? String(error)}`);
      if (e?.stack) slog(`rejection stack: ${String(e.stack).slice(0, 1000)}`);
    };
    if (g.HermesInternal?.enablePromiseRejectionTracker) {
      g.HermesInternal.enablePromiseRejectionTracker({
        allRejections: true,
        onUnhandled,
        onHandled: () => {},
      });
    } else {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const tracking = require("promise/setimmediate/rejection-tracking");
      tracking.enable({ allRejections: true, onUnhandled, onHandled: () => {} });
    }
  } catch (e) {
    slog(`could not install rejection tracker: ${(e as Error)?.message}`);
  }

  slog("crash diagnostics installed");
}

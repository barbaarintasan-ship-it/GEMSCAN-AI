// Offline viewing cache — pure plumbing, no domain knowledge of scans.
// Used by history.tsx, collection-map.tsx, and scan/results.tsx to keep
// previously-fetched collection data (and its thumbnail image bytes) on the
// device so it still renders when there is no network connection.
//
// JSON blobs (small, bounded arrays — up to ~200 rows) go through
// AsyncStorage, matching the existing convention (lib/i18n.ts,
// lib/explanationStyle.ts). Actual image BYTES are separately persisted to
// disk via expo-file-system, because a Supabase signed URL expires after 1
// hour and is useless for offline viewing beyond that window.
//
// Images live under documentDirectory, NOT cacheDirectory: the OS is free to
// purge cacheDirectory under storage pressure, which could silently defeat
// offline viewing at the worst possible moment. The set here is small and
// self-pruned (see pruneImageFiles), so a manually-managed directory is more
// reliable than trusting OS cache eviction.
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system";

const IMAGE_DIR = (FileSystem.documentDirectory ?? "") + "offline-cache/images/";

function safeFileName(cacheKey: string): string {
  return cacheKey.replace(/[^a-zA-Z0-9_-]/g, "_") + ".jpg";
}

async function ensureImageDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(IMAGE_DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(IMAGE_DIR, { intermediates: true });
}

export async function readCachedJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function writeCachedJson<T>(key: string, value: T): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignored — best-effort cache write, never blocks the live path
  }
}

export async function removeCachedJson(key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key);
  } catch {
    // ignored
  }
}

// Checks for an already-downloaded image WITHOUT triggering a network
// request — callers use this first (e.g. scan/results.tsx re-using the
// thumbnail history.tsx already cached for the same scan id) before falling
// back to a fresh signed-URL download.
export async function localImageUriIfCached(cacheKey: string): Promise<string | null> {
  try {
    const path = IMAGE_DIR + safeFileName(cacheKey);
    const info = await FileSystem.getInfoAsync(path);
    return info.exists ? info.uri : null;
  } catch {
    return null;
  }
}

// Downloads once and caches by a STABLE key (the scan id), not by the
// expiring signed URL itself — the underlying image never changes once
// uploaded, so a cache hit skips the network entirely.
export async function cacheImageFile(cacheKey: string, remoteUrl: string): Promise<string | null> {
  const existing = await localImageUriIfCached(cacheKey);
  if (existing) return existing;
  try {
    await ensureImageDir();
    const path = IMAGE_DIR + safeFileName(cacheKey);
    const result = await FileSystem.downloadAsync(remoteUrl, path);
    return result.uri;
  } catch {
    return null;
  }
}

export async function deleteCachedImage(cacheKey: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(IMAGE_DIR + safeFileName(cacheKey), { idempotent: true });
  } catch {
    // ignored
  }
}

// Deletes any cached image file whose key isn't in keepKeys — called after
// every successful live refresh so storage stays bounded to roughly the
// current list size, never growing unbounded across app sessions.
export async function pruneImageFiles(keepKeys: string[]): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(IMAGE_DIR);
    if (!info.exists) return;
    const keepSet = new Set(keepKeys.map(safeFileName));
    const files = await FileSystem.readDirectoryAsync(IMAGE_DIR);
    await Promise.all(
      files
        .filter((f) => !keepSet.has(f))
        .map((f) => FileSystem.deleteAsync(IMAGE_DIR + f, { idempotent: true }).catch(() => {})),
    );
  } catch {
    // ignored — best-effort prune
  }
}

// Small "X min/hours/days ago" formatter for the offline banner — shared
// across history/collection-map/results rather than duplicated per screen,
// since it's pure formatting with no domain coupling to any of them.
export function formatCacheAge(iso: string, so: boolean): string {
  const ms = Math.max(0, Date.now() - new Date(iso).getTime());
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return so ? "hadda dhow" : "just now";
  if (minutes < 60) return so ? `${minutes} daqiiqo ka hor` : `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return so ? `${hours} saac ka hor` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return so ? `${days} maalmood ka hor` : `${days}d ago`;
}

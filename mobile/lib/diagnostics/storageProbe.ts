// ONE-TIME, NON-DESTRUCTIVE diagnostic for the outbox.persist() ~52s freeze
// investigation. Everything here is additive or read-only — nothing existing
// is touched, overwritten, or deleted.
//
//   1. WRITE PROBE: times a setItem to a brand-new key this app has never
//      written before, with a payload the same size as the outbox's current
//      ~44KB. If this is fast while outbox.persist.setItem is slow, the
//      degradation is specific to that key/row, not to AsyncStorage or this
//      device in general.
//   2. BACKUP: reads the outbox, package store and local sample store keys
//      and logs their exact contents to logcat in safe chunks, so the queued
//      field records have a durable copy outside the device BEFORE any
//      destructive testing (clearing app data, a clean reinstall) is done.
//
// Remove this file once the investigation concludes.
import { markPhase } from "./jsStall";

const PROBE_KEY = "diagnostic.writeProbe.v1";
const LOG_CHUNK = 3000;

const BACKUP_KEYS = [
  "sync.outbox.v1",
  "exploration.packages.v1",
  "enterprise.samples.local.v1",
];

async function backupKey(AsyncStorage: { getItem: (k: string) => Promise<string | null> }, key: string): Promise<void> {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) {
    // eslint-disable-next-line no-console
    console.warn(`[storageBackup] ${key}: absent`);
    return;
  }
  // eslint-disable-next-line no-console
  console.warn(`[storageBackup] ${key}: START length=${raw.length}`);
  for (let i = 0; i < raw.length; i += LOG_CHUNK) {
    // eslint-disable-next-line no-console
    console.warn(`[storageBackup] ${key}: chunk ${i / LOG_CHUNK} ${raw.slice(i, i + LOG_CHUNK)}`);
  }
  // eslint-disable-next-line no-console
  console.warn(`[storageBackup] ${key}: END`);
}

export async function runStorageDiagnostic(): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const AsyncStorage = require("@react-native-async-storage/async-storage").default;

    // 1. Fresh-key write probe — same rough size as the current outbox JSON.
    const dummy = JSON.stringify({ probe: true, at: Date.now(), filler: "x".repeat(44_000) });
    const doneProbe = markPhase(`storageProbe.freshKeyWrite[${dummy.length}]`);
    await AsyncStorage.setItem(PROBE_KEY, dummy);
    doneProbe();
    // eslint-disable-next-line no-console
    console.warn(`[storageProbe] fresh-key write of ${dummy.length} chars complete`);

    // A second write to the SAME (now no-longer-fresh) key, to see whether it
    // is the FIRST write to a key that is fast (new row) and subsequent ones
    // degrade, or whether even a repeat write to a small, isolated key stays
    // fast — narrowing whether this is per-row or per-database.
    const doneProbe2 = markPhase(`storageProbe.freshKeyRewrite[${dummy.length}]`);
    await AsyncStorage.setItem(PROBE_KEY, dummy);
    doneProbe2();
    // eslint-disable-next-line no-console
    console.warn("[storageProbe] fresh-key re-write complete");

    // 2. Back up everything before any destructive testing is considered.
    for (const key of BACKUP_KEYS) await backupKey(AsyncStorage, key);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[storageProbe] failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

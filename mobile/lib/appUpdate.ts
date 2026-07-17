// App-update check. On launch the app reads the single `app_config` row from
// Supabase and compares its own version (app.json "version" / versionName) with
// the newest published version. If it is behind, the UpdateGate shows a prompt
// linking to the Play Store. Fails open: any error (offline, table missing)
// simply shows nothing.
//
// IMPORTANT: this compares versionName (e.g. 1.0.0), NOT the Android versionCode.
// So bump app.json "version" on each release you want to prompt users about
// (e.g. 1.0.0 → 1.0.1), then set app_config.latest_version to the same value.
import Constants from "expo-constants";
import { supabase } from "./supabase";

export type AppUpdateInfo = {
  updateAvailable: boolean;
  forced: boolean; // true when below min_version → no "Later" option.
  message: { en: string; so: string };
  storeUrl: string;
};

/** Split "1.2.3" → [1,2,3] (non-numeric segments become 0). */
function parseVersion(v: string): number[] {
  return String(v || "0")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
}

/** -1 if a<b, 0 if equal, 1 if a>b (semver-ish, numeric segments). */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/** The installed app's versionName, e.g. "1.0.0". */
export function currentVersion(): string {
  return (Constants.expoConfig?.version as string) || "0.0.0";
}

/**
 * Returns update info when the installed version is behind, else null.
 */
export async function checkForUpdate(): Promise<AppUpdateInfo | null> {
  try {
    const { data, error } = await supabase
      .from("app_config")
      .select("latest_version, min_version, update_message_en, update_message_so, store_url")
      .limit(1)
      .maybeSingle();

    if (error || !data) return null;

    const cur          = currentVersion();
    const behindLatest = compareVersions(cur, data.latest_version) < 0;
    const belowMin     = compareVersions(cur, data.min_version) < 0;

    if (!behindLatest && !belowMin) return null;

    return {
      updateAvailable: true,
      forced: belowMin,
      message: {
        en: data.update_message_en || "A new version of GemScan is available.",
        so: data.update_message_so || "Nooc cusub oo GemScan ah ayaa diyaar ah.",
      },
      storeUrl:
        data.store_url || "https://play.google.com/store/apps/details?id=com.gemscan.ai",
    };
  } catch {
    return null; // Fail open — never block the app because of the update check.
  }
}

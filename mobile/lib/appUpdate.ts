// App-update check. On launch the app reads the single `app_config` row from
// Supabase and compares its own Android versionCode (the build number that EAS
// auto-increments on every production build) with the newest published build.
// If it is behind, the UpdateGate shows a prompt linking to the Play Store.
// Fails open: any error (offline, table missing) simply shows nothing.
//
// Using versionCode (not versionName) means you NEVER edit app.json for this —
// EAS bumps the build number automatically. After publishing a release you only
// set app_config.latest_build to that build's number (shown in EAS / Play).
import * as Application from "expo-application";
import { supabase } from "./supabase";

export type AppUpdateInfo = {
  updateAvailable: boolean;
  forced: boolean; // true when below min_build → no "Later" option.
  message: { en: string; so: string };
  storeUrl: string;
};

/**
 * The installed app's build number (Android versionCode / iOS build number).
 * Returns 0 when it cannot be read, which disables the gate (fail open).
 */
export function currentBuild(): number {
  const raw = Application.nativeBuildVersion; // e.g. "17" on Android.
  const n = parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Returns update info when the installed build is behind, else null.
 */
export async function checkForUpdate(): Promise<AppUpdateInfo | null> {
  try {
    const build = currentBuild();
    if (!build) return null; // Unknown build → never prompt.

    const { data, error } = await supabase
      .from("app_config")
      .select("latest_build, min_build, update_message_en, update_message_so, store_url")
      .limit(1)
      .maybeSingle();

    if (error || !data) return null;

    const latest = Number(data.latest_build) || 0;
    const min = Number(data.min_build) || 0;

    const behindLatest = build < latest;
    const belowMin = build < min;
    if (!behindLatest && !belowMin) return null;

    return {
      updateAvailable: true,
      forced: belowMin,
      message: {
        en: data.update_message_en || "A new version of LuulScan is available.",
        so: data.update_message_so || "Nooc cusub oo LuulScan ah ayaa diyaar ah.",
      },
      storeUrl:
        data.store_url || "https://play.google.com/store/apps/details?id=com.gemscan.ai",
    };
  } catch {
    return null; // Fail open — never block the app because of the update check.
  }
}

// The app has ONE version, written in two places.
//
// `android/app/build.gradle` is what Android and Play read. `app.json` is what
// expo-constants bundles into the APK as an asset, and that asset is what the
// Settings screen shows the geologist.
//
// Nothing connects them. They have drifted apart twice:
//
//   • The `createExpoConfig` task declared an output directory and no inputs, so
//     Gradle held it up to date and never regenerated it. An APK shipped whose
//     native versionCode was 62 while the bundled asset still said 1.2.0 (58) —
//     the phone reported a version this repo had never built, and no amount of
//     editing app.json could correct it. Fixed with the `projectsEvaluated` hook
//     in build.gradle.
//   • They drifted again anyway — 1.23.0 native (107) against 1.23.0 asset (100)
//     — because the hook only guarantees the asset is REBUILT, not that the two
//     numbers agree in the first place.
//
// The hook and this test do different jobs, and both are needed. A stale version
// on a field phone is not cosmetic: it is how a bug report arrives against a
// build nobody can identify, and how a geologist is told their app is current
// when it is not.
import * as fs from "fs";
import * as path from "path";

const MOBILE = path.join(__dirname, "..", "..");

const appJson = JSON.parse(
  fs.readFileSync(path.join(MOBILE, "app.json"), "utf8"),
).expo as { version: string; android?: { versionCode?: number } };

const gradle = fs.readFileSync(
  path.join(MOBILE, "android", "app", "build.gradle"), "utf8",
);

/** Read from the real `defaultConfig` line, not from a comment mentioning one. */
function fromGradle(key: "versionCode" | "versionName"): string {
  const m = gradle.match(
    key === "versionCode"
      ? /^\s*versionCode\s+(\d+)\s*$/m
      : /^\s*versionName\s+"([^"]+)"\s*$/m,
  );
  if (!m) throw new Error(`${key} not found in android/app/build.gradle`);
  return m[1];
}

describe("the two version sources agree", () => {
  test("versionName matches app.json version", () => {
    expect(fromGradle("versionName")).toBe(appJson.version);
  });

  test("versionCode matches app.json android.versionCode", () => {
    expect(Number(fromGradle("versionCode"))).toBe(appJson.android?.versionCode);
  });
});

describe("the version is shaped like a version", () => {
  test("versionName is semver-ish", () => {
    expect(appJson.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("versionCode is a positive integer", () => {
    const code = appJson.android?.versionCode;
    expect(Number.isInteger(code)).toBe(true);
    expect(code as number).toBeGreaterThan(0);
  });

  test("versionCode never goes backwards past a build that shipped", () => {
    // Play rejects a versionCode at or below one already uploaded, and it does so
    // at submission — long after the APK was built, tested and handed round.
    //
    // Raised to 108 because 108 was built AND installed on a test device. A second
    // 108 carrying different code is the exact confusion this file exists to stop:
    // a bug report arrives against a version number that identifies two builds.
    const SHIPPED_HIGH_WATER_MARK = 115;
    expect(appJson.android?.versionCode as number).toBeGreaterThan(SHIPPED_HIGH_WATER_MARK);
  });
});

describe("the regeneration hook that keeps the asset fresh is still there", () => {
  test("createExpoConfig is forced to re-run every build", () => {
    // Without this, Gradle caches the bundled app config for as long as the output
    // directory exists, and the asset keeps a version from an old build.
    const code = gradle.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).toContain("createExpoConfig");
    expect(code).toContain("upToDateWhen { false }");
  });

  test("the hook searches ALL projects, not just :app", () => {
    // The task lives on :expo-constants. A first attempt searched :app's own task
    // list, found nothing, and silently did nothing — which is how the same stale
    // version shipped twice.
    const code = gradle.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).toContain("rootProject.allprojects");
    expect(code).toContain("projectsEvaluated");
  });
});

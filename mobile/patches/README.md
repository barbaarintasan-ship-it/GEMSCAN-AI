# Dependency patches (patch-package)

These patches are applied automatically after `npm install` via the
`postinstall: "patch-package"` script — including on EAS Build — so the fixes
are reproducible and survive reinstalls.

## expo-modules-core+1.12.26.patch

### Original error (EAS "Run gradlew" phase, Android production build)
```
e: .../expo-modules-core/android/.../permissions/PermissionsService.kt:166:36
   Only safe (?.) or non-null asserted (!!.) calls are allowed on a
   nullable receiver of type Array<(out) String!>?
> Task :expo-modules-core:compileReleaseKotlin FAILED
```

### Exact line changed
`PermissionsService.kt`, inside `isPermissionPresentInManifest(...)`:
```diff
-        return requestedPermissions.contains(permission)
+        return requestedPermissions?.contains(permission) == true
```

### Why the fix is correct
`requestedPermissions` is `android.content.pm.PackageInfo.requestedPermissions`
(a Java field). In the Android API 34 SDK stubs it is an unannotated
`String[]`, which Kotlin treats as a platform type (`Array<String!>!`) and lets
you call `.contains(...)` on directly. In the **API 35** stubs the same field is
annotated `@Nullable String[]`, so Kotlin now sees `Array<String!>?` and
(correctly) refuses an unguarded `.contains(...)` call. Using the safe-call
operator and comparing to `true` (`?.contains(permission) == true`) returns
`false` when the array is null and otherwise behaves identically to the
original. This is exactly the change Expo shipped in later expo-modules-core
releases (the SDK 52 version, 2.2.x, already contains an equivalent guard).

### Why it is safe
- Behaviour is unchanged whenever `requestedPermissions` is non-null (the only
  case that occurred under API 34). When it is null (possible only under API 35),
  the method returns `false` — the correct answer, since a null permission array
  means the queried permission is not present in the manifest.
- The change is one expression, contains no new APIs, and does not alter the
  method signature or any caller.
- It compiles cleanly against both API 34 and API 35, so it is forward- and
  backward-compatible.

### Why upgrading to Expo SDK 52 is NOT necessary
The Android production build's only failure was this single Kotlin
null-safety compile error. The toolchain itself is fully compatible with
`compileSdk`/`targetSdk = 35` on Expo SDK 51:
- Google requires **AGP 8.6.0+** and **Gradle 8.7+** for compileSdk 35 — the
  project uses **AGP 8.6.0** (pinned in `android/build.gradle`) and **Gradle
  8.8**, both of which satisfy the requirement.
- A local `:app:help`/config run and the EAS build both completed
  configuration, JS bundling, and nearly all Kotlin compilation before failing
  only on this one line — proving there is no AGP/Gradle/SDK incompatibility.

Because the sole blocker is a one-line dependency source fix that patch-package
resolves reproducibly, the large, higher-risk Expo SDK 51 → 52 upgrade (React
Native 0.74 → 0.76, ~40 packages, New Architecture) is unnecessary.

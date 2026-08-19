# Dependency patches (patch-package)

These patches are applied automatically after `npm install` via the
`postinstall: "patch-package"` script — including on EAS Build — so the fixes
are reproducible and survive reinstalls.

Current patches (Expo SDK 53 / React Native 0.79):

## h3-js+4.1.0.patch

### Problem (introduced by Expo SDK 53)
Expo SDK 53 installs a **UTF-8-only** `TextDecoder` as a global (its "winter"
runtime, `expo/src/winter/TextDecoder.ts` — "we only need utf-8 decoder for
React Server Components"). `h3-js`'s emscripten glue constructs
`new TextDecoder("utf-16le")` eagerly at module load. Under SDK 53 that global
throws `RangeError: Unknown encoding: utf-16le`, so **importing `h3-js` crashes**
— at app runtime (any exploration screen) and in every Jest suite that touches
h3 (~30 suites failed to even load).

Before SDK 53 there was no global `TextDecoder`, so h3-js's
`typeof TextDecoder !== "undefined" ? new TextDecoder("utf-16le") : undefined`
guard evaluated to `undefined` and h3-js used its built-in manual decoder.

### Exact change
In each shipped bundle (`dist/h3-js.js` used by Jest/Node, `dist/browser/h3-js.js`
used by Metro via the package's `browser` field, plus the `.es`/`.umd` variants),
the single eager construction is neutralised:
```diff
- ... typeof TextDecoder !== "undefined" ? new TextDecoder("utf-16le") : undefined
+ ... typeof TextDecoder !== "undefined" ? void 0 : undefined
```
This forces `UTF16Decoder = undefined`, so emscripten falls back to its manual
UTF-16 decode loop — **identical output**, and exactly the path used on every SDK
before 53. The `utf8` decoder is untouched (the winter runtime supports utf-8).

### Why it is safe
The manual fallback is byte-for-byte equivalent and is what h3-js used for the
app's entire history before SDK 53. H3 returns ASCII cell-id strings, so the
UTF-16 path is rarely (if ever) exercised anyway.

## expo-modules-core+2.5.0.patch

### Problem
`PackageInfo.requestedPermissions` is `@Nullable String[]` in the API 35 SDK
stubs. expo-modules-core 2.5.0's `isPermissionPresentInManifest(...)` calls
`requestedPermissions!!.contains(permission)`, which throws
`NullPointerException` if an app declares no permissions.

### Exact line changed
`PermissionsService.kt`, inside `isPermissionPresentInManifest(...)`:
```diff
-        return requestedPermissions!!.contains(permission)
+        return requestedPermissions?.contains(permission) == true
```

### Why it is safe
When `requestedPermissions` is non-null (this app declares CAMERA/LOCATION, so
always) behaviour is identical; when null it returns `false` (the correct answer
— the permission is not present). One expression, no new APIs, no signature
change. This restores the same defensive guard the project carried on SDK 51
(previously `expo-modules-core+1.12.26.patch`), re-based onto 2.5.0.

## Removed: react-native-screens+3.31.1.patch
The `drawingOpPool.removeLast()` → `removeAt(lastIndex)` fix (an Android-15
`NoSuchMethodError` guard) is **fixed upstream** in react-native-screens 4.11.1
(`ScreenStack.kt` now uses `removeAt(drawingOpPool.lastIndex)` with the same
SDK-35 rationale), so the patch is no longer needed and was deleted.

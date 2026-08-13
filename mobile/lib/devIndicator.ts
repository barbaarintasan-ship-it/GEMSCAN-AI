// TEMPORARY developer indicator — Exploration Platform v2, Slices 1 and 2.
//
// Both slices are architectural: the map moved into a layout route that never
// unmounts, and the field session became an expedition with a durable outbox
// behind it. Neither shows up as a new button, which makes them hard to confirm
// on a device — the app looks the same when they are working and the same when
// they have silently regressed.
//
// This used to also drive a badge floating on the map itself. It stated the same
// three facts the diagnostics panel states — map host live, expedition id, queue
// depth — and paid for them in map pixels, on the one screen where the map IS
// the product. The badge is gone; the facts stayed, as the `Map OS`,
// `Expedition ID` and `Field records` rows of the panel below the sheet.
//
// NOT gated on __DEV__ on purpose: it has to be visible in the RELEASE APK that
// gets installed on a phone. It is gated on this one constant instead.
//
// ── TO REMOVE ──────────────────────────────────────────────────────────────
//   Set DEV_INDICATOR_ENABLED to false — the diagnostics section and the crash
//   detail on the error screen both disappear. Delete this file,
//   components/DevDiagnostics.tsx and the two call sites to remove it entirely.
export const DEV_INDICATOR_ENABLED = true;

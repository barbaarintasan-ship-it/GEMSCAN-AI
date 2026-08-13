// The field camera as a SCREEN, for callers that are screens.
//
// The camera itself is `components/FieldCamera` — it had to stop being a route so
// the Add Waypoint form could use it too. That form is a `Modal`, and a React
// Native modal renders above the router's stack, so a pushed camera would have
// been hidden behind the very form that opened it.
//
// What is left here is the screen-shaped part and nothing else: no camera state,
// no capture logic. The photos go back through `lib/captureHandoff` — a single
// in-memory slot the sample form drains on focus — because Expo Router passes
// params through a URL, which is the wrong place for a burst of file paths.
//
// This screen owns no sample state and creates nothing on the server.
import React from "react";
import { router, useLocalSearchParams, Stack } from "expo-router";
import { FieldCamera, SHOT_NEEDS } from "../../../components/FieldCamera";
import { putCapturedPhotos } from "../../../lib/captureHandoff";

// Re-exported from their new home so `lib/shotNeeds` and anything else that has
// always imported them from this path keeps working.
export { SHOT_NEEDS };
export type { ShotNeed } from "../../../components/FieldCamera";

export default function FieldCameraScreen() {
  const { need } = useLocalSearchParams<{ need?: string }>();
  const needs = React.useMemo(
    () => (need ? need.split(",").filter((n) => (SHOT_NEEDS as readonly string[]).includes(n)) : []),
    [need],
  );

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <FieldCamera
        needs={needs}
        onDone={(photos) => { putCapturedPhotos(photos); router.back(); }}
        onCancel={() => router.back()}
      />
    </>
  );
}

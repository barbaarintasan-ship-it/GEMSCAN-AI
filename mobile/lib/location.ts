// Precise capture location for a scan (where the specimen was found).
//
// The owner wants the map to show the EXACT find location, so we request the
// highest GPS accuracy the device can provide and store the full-precision
// coordinates (plus the reported accuracy radius in metres) — no rounding.
import * as Location from "expo-location";
import type { ScanLocation } from "./scanUpload";

export async function getPreciseLocation(): Promise<ScanLocation | null> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") return null;

    const position = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Highest,
      // Don't accept a stale cached fix — get a fresh, accurate reading.
      mayShowUserSettingsDialog: true,
    });

    return {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      acc:
        typeof position.coords.accuracy === "number"
          ? Math.round(position.coords.accuracy)
          : undefined,
    };
  } catch {
    return null;
  }
}

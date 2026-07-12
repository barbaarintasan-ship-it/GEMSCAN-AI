// Optional, coarse, client-fuzzed location for the Geological Context Engine
// (Stage 4). Per the location-fuzzing policy in
// 05-Monetization-Legal-Payments.md, we deliberately round to ~1-2km
// precision here — never store or transmit an exact find location — so a
// sensitive collecting site can't be reconstructed from scan data.
import * as Location from "expo-location";
import type { ScanLocation } from "./scanUpload";

const FUZZ_DECIMAL_PLACES = 2; // ~1.1km precision at the equator

export async function getFuzzedLocation(): Promise<ScanLocation | null> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") return null;

    const position = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Low,
    });

    const factor = 10 ** FUZZ_DECIMAL_PLACES;
    return {
      lat: Math.round(position.coords.latitude * factor) / factor,
      lng: Math.round(position.coords.longitude * factor) / factor,
    };
  } catch {
    return null;
  }
}

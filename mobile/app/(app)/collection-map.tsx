// Collection Map — plots every scan that has a (coarse, fuzzed) capture
// location as a pin on a keyless OpenStreetMap. Tapping a pin's popup opens
// that scan's results. Pure read view over scans.capture_location; it does not
// touch the scan/identification pipeline.
import React, { useCallback, useLayoutEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { useRouter, useFocusEffect, useNavigation } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth";
import LocationMap, { MapMarker } from "../../components/LocationMap";

type ScanFinalResult = { bestMatch: string | null } | null;

export default function CollectionMapScreen() {
  const { i18n } = useTranslation();
  const so = i18n.language === "so";
  const router = useRouter();
  const navigation = useNavigation();
  const { session } = useAuth();

  const [markers, setMarkers] = useState<MapMarker[]>([]);
  const [loading, setLoading] = useState(true);

  useLayoutEffect(() => {
    navigation.setOptions({ title: so ? "Khariidadda Ururka" : "Collection Map" });
  }, [navigation, so]);

  const load = useCallback(async () => {
    if (!session?.user.id) return;
    const { data } = await supabase
      .from("scans")
      .select("id, final_result, capture_location, created_at")
      .eq("user_id", session.user.id)
      .not("capture_location", "is", null)
      .order("created_at", { ascending: false })
      .limit(200);

    const pins: MapMarker[] = [];
    (data ?? []).forEach((row: any) => {
      const loc = row.capture_location as { lat?: number; lng?: number } | null;
      if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") return;
      const fr = row.final_result as ScanFinalResult;
      pins.push({
        id: row.id,
        lat: loc.lat,
        lng: loc.lng,
        title: fr?.bestMatch ?? (so ? "Baaris" : "Scan"),
      });
    });
    setMarkers(pins);
  }, [session?.user.id, so]);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        setLoading(true);
        await load();
        if (active) setLoading(false);
      })();
      return () => {
        active = false;
      };
    }, [load]),
  );

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#C9A227" size="large" />
      </View>
    );
  }

  if (markers.length === 0) {
    return (
      <View style={styles.centered}>
        <Ionicons name="map-outline" size={56} color="#3A3A3D" />
        <Text style={styles.emptyTitle}>{so ? "Weli goobo ma jiraan" : "No mapped finds yet"}</Text>
        <Text style={styles.emptyHint}>
          {so
            ? "Marka aad wax baartid oo aad ogolaatid goobta, halkan ayaa lagu calaamadyn doonaa."
            : "When you scan with location enabled, your finds are pinned here."}
        </Text>
        <Pressable style={styles.primaryButton} onPress={() => router.push("/(app)/scan/live")}>
          <Text style={styles.primaryButtonText}>{so ? "Bilow baaris" : "Start scanning"}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.banner}>
        <Ionicons name="location" size={15} color="#2EE66E" />
        <Text style={styles.bannerText}>
          {markers.length} {so ? "goobo la calaamadeeyay" : markers.length === 1 ? "find mapped" : "finds mapped"}
        </Text>
      </View>
      <LocationMap
        markers={markers}
        fill
        interactive
        onMarkerPress={(id) =>
          router.push({ pathname: "/(app)/scan/results", params: { scanId: id } })
        }
      />
      <Text style={styles.note}>
        {so
          ? "Calaamad kasta waa goobta GPS-ka saxda ah ee shayga laga baaray. Taabo si aad u aragto."
          : "Each pin is the exact GPS spot where a specimen was scanned. Tap a pin to open it."}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0B0B0C", padding: 12, gap: 10 },
  banner: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4 },
  bannerText: { color: "#F5F1E8", fontWeight: "700", fontSize: 14 },
  note: { color: "#8A8A8E", fontSize: 12, textAlign: "center", fontStyle: "italic" },
  centered: {
    flex: 1,
    backgroundColor: "#0B0B0C",
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 12,
  },
  emptyTitle: { fontSize: 20, fontWeight: "700", color: "#F5F1E8", marginTop: 8 },
  emptyHint: { fontSize: 14, color: "#8A8A8E", textAlign: "center", lineHeight: 20 },
  primaryButton: {
    backgroundColor: "#C9A227",
    borderRadius: 999,
    paddingVertical: 14,
    paddingHorizontal: 28,
    alignItems: "center",
    marginTop: 8,
  },
  primaryButtonText: { color: "#0B0B0C", fontWeight: "700", fontSize: 15 },
});

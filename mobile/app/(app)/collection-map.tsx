// Collection Map — plots every scan that has a (coarse, fuzzed) capture
// location as a pin on a keyless OpenStreetMap. Tapping a pin's popup opens
// that scan's results. Pure read view over scans.capture_location; it does not
// touch the scan/identification pipeline.
import React, { useCallback, useLayoutEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { useRouter, useFocusEffect, useNavigation } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth";
import { readCachedJson, writeCachedJson, formatCacheAge } from "../../lib/offlineCache";
import { useIsOnline } from "../../lib/network";
import LocationMap, { MapMarker } from "../../components/LocationMap";
import { EmptyState } from "../../components/ui/EmptyState";
import { OfflineBanner } from "../../components/ui/OfflineBanner";

type ScanFinalResult = { bestMatch: string | null } | null;

// Offline cache — no image bytes needed here (pins carry no thumbnail), just
// the marker list itself. Map TILES still require network regardless; this
// only keeps the pins/popups themselves viewable offline.
type MapCache = { cachedAt: string; markers: MapMarker[] };

function mapCacheKey(userId: string): string {
  return `gemscan.cache.map.v1:${userId}`;
}

export default function CollectionMapScreen() {
  const { i18n, t } = useTranslation();
  const so = i18n.language === "so";
  const router = useRouter();
  const navigation = useNavigation();
  const { session } = useAuth();
  const isOnline = useIsOnline();

  const [markers, setMarkers] = useState<MapMarker[]>([]);
  const [loading, setLoading] = useState(true);
  const [dataSource, setDataSource] = useState<"cache" | "live">("live");
  const [cachedAt, setCachedAt] = useState<string | null>(null);

  useLayoutEffect(() => {
    navigation.setOptions({ title: so ? "Khariidadda Kaydka" : "Collection Map" });
  }, [navigation, so]);

  const loadFromCache = useCallback(async (): Promise<boolean> => {
    if (!session?.user.id) return false;
    const cached = await readCachedJson<MapCache>(mapCacheKey(session.user.id));
    if (!cached || cached.markers.length === 0) return false;
    setMarkers(cached.markers);
    setDataSource("cache");
    setCachedAt(cached.cachedAt);
    return true;
  }, [session?.user.id]);

  const loadLive = useCallback(async (): Promise<boolean> => {
    if (!session?.user.id) return false;
    const { data, error } = await supabase
      .from("scans")
      .select("id, final_result, capture_location, created_at")
      .eq("user_id", session.user.id)
      .not("capture_location", "is", null)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) return false;

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
    setDataSource("live");
    setCachedAt(null);
    writeCachedJson<MapCache>(mapCacheKey(session.user.id), {
      cachedAt: new Date().toISOString(),
      markers: pins,
    }).catch(() => {});
    return true;
  }, [session?.user.id, so]);

  const refresh = useCallback(async () => {
    const hadCache = await loadFromCache();
    setLoading(!hadCache);
    if (isOnline) {
      await loadLive();
    }
    setLoading(false);
  }, [loadFromCache, loadLive, isOnline]);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  const bannerMessage = useMemo(() => {
    if (dataSource !== "cache" || !cachedAt) return null;
    const age = formatCacheAge(cachedAt, so);
    return isOnline ? t("history.refreshFailedShowingSaved", { age }) : t("history.offlineShowingSaved", { age });
  }, [dataSource, cachedAt, isOnline, so, t]);

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
        <EmptyState
          icon="map-outline"
          title={so ? "Weli goobo ma jiraan" : "No mapped finds yet"}
          hint={
            so
              ? "Marka aad wax baartid oo aad ogolaatid goobta, halkan ayaa lagu calaamadyn doonaa."
              : "When you scan with location enabled, your finds are pinned here."
          }
          ctaLabel={so ? "Bilow baaris" : "Start scanning"}
          onPressCta={() => router.push("/(app)/scan/live")}
        />
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
      {bannerMessage && <OfflineBanner message={bannerMessage} />}
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
});

// My Collection / Scan History.
//
// Lists the signed-in user's past scans (RLS-scoped) newest-first with a
// thumbnail of the first uploaded image, the AI best match, confidence and
// date. Tapping a row opens the existing results screen, which re-reads the
// scan from the database — so history is a pure read view over data the scan
// pipeline already wrote; it changes nothing about that pipeline.
import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  Image,
  Pressable,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { useRouter, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth";

type ScanFinalResult = {
  bestMatch: string | null;
  confidenceScore: number;
  confidenceBand: "low" | "medium" | "high";
  insufficientConfidence: boolean;
} | null;

type HistoryItem = {
  id: string;
  status: string;
  final_result: ScanFinalResult;
  created_at: string;
  location: { lat: number; lng: number } | null;
  thumbnailUrl: string | null;
};

const BAND_COLOR: Record<string, string> = {
  high: "#2E7D32",
  medium: "#C9A227",
  low: "#8A8A8E",
};

export default function HistoryScreen() {
  const { t, i18n } = useTranslation();
  const so = i18n.language === "so";
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { session } = useAuth();

  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    if (!session?.user.id) return;
    setError(false);
    const { data, error: queryError } = await supabase
      .from("scans")
      .select("id, status, final_result, created_at, capture_location, scan_images(original_storage_path)")
      .eq("user_id", session.user.id)
      .order("created_at", { ascending: false })
      .limit(100);

    if (queryError || !data) {
      setError(true);
      setItems([]);
      return;
    }

    // Batch-sign the first image of each scan (the bucket is private, so raw
    // storage paths aren't directly loadable).
    const firstPaths = data
      .map((row: any) => row.scan_images?.[0]?.original_storage_path as string | undefined)
      .filter((p: string | undefined): p is string => Boolean(p));

    const signedByPath = new Map<string, string>();
    if (firstPaths.length > 0) {
      const { data: signed } = await supabase.storage
        .from("scan-images")
        .createSignedUrls(firstPaths, 3600);
      signed?.forEach((s) => {
        if (s.signedUrl && s.path) signedByPath.set(s.path, s.signedUrl);
      });
    }

    setItems(
      data.map((row: any) => {
        const path = row.scan_images?.[0]?.original_storage_path as string | undefined;
        const loc = row.capture_location as { lat?: number; lng?: number } | null;
        return {
          id: row.id,
          status: row.status,
          final_result: row.final_result as ScanFinalResult,
          created_at: row.created_at,
          location:
            loc && typeof loc.lat === "number" && typeof loc.lng === "number"
              ? { lat: loc.lat, lng: loc.lng }
              : null,
          thumbnailUrl: path ? signedByPath.get(path) ?? null : null,
        };
      }),
    );
  }, [session?.user.id]);

  // Reload whenever the screen regains focus so a scan the user just finished
  // shows up when they navigate here.
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

  async function onRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  function resultLine(item: HistoryItem): { text: string; muted: boolean } {
    if (item.status === "failed") return { text: t("history.failed"), muted: true };
    if (item.status !== "completed") return { text: t("history.processing"), muted: true };
    const fr = item.final_result;
    if (!fr || fr.insufficientConfidence || !fr.bestMatch)
      return { text: t("history.noResult"), muted: true };
    return { text: fr.bestMatch, muted: false };
  }

  function renderItem({ item }: { item: HistoryItem }) {
    const line = resultLine(item);
    const fr = item.final_result;
    const showConfidence = !line.muted && fr;
    const when = new Date(item.created_at);
    const date = when.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    const time = when.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });

    return (
      <Pressable
        style={styles.itemCard}
        onPress={() =>
          router.push({ pathname: "/(app)/scan/results", params: { scanId: item.id } })
        }
      >
        {item.thumbnailUrl ? (
          <Image source={{ uri: item.thumbnailUrl }} style={styles.thumb} />
        ) : (
          <View style={[styles.thumb, styles.thumbPlaceholder]}>
            <Ionicons name="diamond-outline" size={22} color="#8A8A8E" />
          </View>
        )}

        <View style={styles.itemBody}>
          <Text style={[styles.itemTitle, line.muted && styles.itemTitleMuted]} numberOfLines={1}>
            {line.text}
          </Text>
          <View style={styles.metaRow}>
            {showConfidence && fr && (
              <View style={[styles.bandPill, { backgroundColor: BAND_COLOR[fr.confidenceBand] }]}>
                <Text style={styles.bandPillText}>{Math.round(fr.confidenceScore * 100)}%</Text>
              </View>
            )}
            <Text style={styles.dateText}>
              {date} · {time}
            </Text>
            {item.location && (
              <View style={styles.locChip}>
                <Ionicons name="location" size={11} color="#2EE66E" />
              </View>
            )}
          </View>
        </View>

        <Ionicons name="chevron-forward" size={20} color="#8A8A8E" />
      </Pressable>
    );
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#C9A227" size="large" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyHint}>{t("history.loadError")}</Text>
        <Pressable style={styles.primaryButton} onPress={onRefresh}>
          <Text style={styles.primaryButtonText}>{t("common.retry")}</Text>
        </Pressable>
      </View>
    );
  }

  if (items.length === 0) {
    return (
      <View style={styles.centered}>
        <Ionicons name="diamond-outline" size={56} color="#3A3A3D" />
        <Text style={styles.emptyTitle}>{t("history.emptyTitle")}</Text>
        <Text style={styles.emptyHint}>{t("history.emptyHint")}</Text>
        <Pressable
          style={styles.primaryButton}
          onPress={() => router.push("/(app)/scan/live")}
        >
          <Text style={styles.primaryButtonText}>{t("history.startScanning")}</Text>
        </Pressable>
      </View>
    );
  }

  const locatedCount = items.filter((i) => i.location).length;

  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={[styles.listContent, { paddingBottom: 16 + insets.bottom }]}
      data={items}
      keyExtractor={(item) => item.id}
      renderItem={renderItem}
      ListHeaderComponent={
        <View style={styles.header}>
          <View style={styles.headerTop}>
            <View>
              <Text style={styles.headerTitle}>💎 {so ? "Kaydkaaga" : "My Collection"}</Text>
              <Text style={styles.headerCount}>
                {items.length} {so ? "baaris" : items.length === 1 ? "scan" : "scans"}
                {locatedCount > 0 ? ` · ${locatedCount} ${so ? "goobo la calaamadeeyay" : "mapped"}` : ""}
              </Text>
            </View>
            {locatedCount > 0 && (
              <Pressable
                style={styles.mapButton}
                onPress={() => router.push("/(app)/collection-map")}
              >
                <Ionicons name="map" size={16} color="#0B0B0C" />
                <Text style={styles.mapButtonText}>{so ? "Khariidad" : "Map"}</Text>
              </Pressable>
            )}
          </View>
        </View>
      }
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#C9A227" />
      }
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0B0B0C" },
  listContent: { padding: 16, gap: 10 },
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
  itemCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#1A1A1D",
    borderRadius: 14,
    padding: 12,
  },
  thumb: { width: 56, height: 56, borderRadius: 10, backgroundColor: "#2A2A2C" },
  thumbPlaceholder: { alignItems: "center", justifyContent: "center" },
  itemBody: { flex: 1, gap: 4 },
  itemTitle: { fontSize: 16, fontWeight: "600", color: "#F5F1E8" },
  itemTitleMuted: { color: "#8A8A8E", fontWeight: "500" },
  header: { paddingVertical: 8, paddingHorizontal: 4, marginBottom: 4 },
  headerTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  headerTitle: { fontSize: 22, fontWeight: "800", color: "#C9A227" },
  headerCount: { fontSize: 13, color: "#8A8A8E", marginTop: 2 },
  mapButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "#C9A227",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  mapButtonText: { color: "#0B0B0C", fontWeight: "800", fontSize: 13 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  bandPill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  bandPillText: { fontSize: 11, color: "#0B0B0C", fontWeight: "800" },
  dateText: { fontSize: 12, color: "#8A8A8E" },
  locChip: { flexDirection: "row", alignItems: "center" },
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

// Batch Scan results: one row per photo processed by the batch (see
// app/(app)/scan/batch.tsx). Pure read view over what the batch loop already
// produced — tapping a completed row opens the EXISTING single-scan Results
// screen (no new result format), exactly like History does.
import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  Image,
  Pressable,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  Share,
  Linking,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useSubscriptionStatus } from "../../../lib/subscription";
import { generateBatchSummaryPdf } from "../../../lib/batchReport";
import { PAYMENT_URL, EXTERNAL_PURCHASES_ENABLED } from "../../../lib/appLinks";
import type { BatchItemResult, BatchStopReason } from "../../../lib/batchTypes";

const BAND_COLOR: Record<string, string> = {
  high: "#2E7D32",
  medium: "#C9A227",
  low: "#8A8A8E",
};

export default function BatchResultsScreen() {
  const { data, stopReason } = useLocalSearchParams<{ data: string; stopReason?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { i18n } = useTranslation();
  const lang: "en" | "so" = i18n.language === "so" ? "so" : "en";
  const L = (en: string, so: string) => (lang === "so" ? so : en);

  const items: BatchItemResult[] = useMemo(() => {
    try {
      return JSON.parse(data ?? "[]") as BatchItemResult[];
    } catch {
      return [];
    }
  }, [data]);
  const reason: BatchStopReason = (stopReason || null) as BatchStopReason;

  const { data: sub } = useSubscriptionStatus();
  const canPdf = sub?.features?.pdfReports ?? false;
  const [pdfBusy, setPdfBusy] = useState(false);
  const [sharing, setSharing] = useState(false);

  const completed = items.filter((i) => i.status === "completed").length;
  const failed = items.filter((i) => i.status === "failed").length;
  const skipped = items.filter((i) => i.status === "skipped").length;

  function statusText(item: BatchItemResult): { text: string; color: string } {
    if (item.status === "completed") {
      return { text: item.label ?? L("No confident match", "Aqoonsi la hubo lama helin"), color: "#F5F1E8" };
    }
    if (item.status === "failed") return { text: L("Failed", "Fashilmay"), color: "#E4685D" };
    return { text: L("Skipped", "La booday"), color: "#8A8A8E" };
  }

  function openItem(item: BatchItemResult) {
    if (item.status !== "completed" || !item.scanId) return;
    router.push({ pathname: "/(app)/scan/results", params: { scanId: item.scanId } });
  }

  async function shareSummary() {
    if (sharing) return;
    setSharing(true);
    try {
      const lines = [
        L("💎 LuulScan — Batch Scan summary", "💎 LuulScan — Soo koobid Batch Scan"),
        "",
        `${L("Items", "Shayada")}: ${items.length}`,
        `${L("Completed", "Dhammaystiran")}: ${completed}`,
        `${L("Failed", "Fashilmay")}: ${failed}`,
        `${L("Skipped", "La booday")}: ${skipped}`,
        "",
        ...items
          .filter((i) => i.status === "completed")
          .map((i, idx) => `${idx + 1}. ${i.label ?? "—"} — ${i.confidencePct ?? 0}%${i.valueLabel ? ` — ${i.valueLabel}` : ""}`),
      ];
      await Share.share({ message: lines.join("\n") });
    } catch {
      /* dismissed — no-op */
    } finally {
      setSharing(false);
    }
  }

  async function exportPdf() {
    if (pdfBusy || !canPdf) return;
    setPdfBusy(true);
    try {
      await generateBatchSummaryPdf(items, lang);
    } catch {
      /* generation/share failed or was dismissed — no-op */
    } finally {
      setPdfBusy(false);
    }
  }

  function renderItem({ item }: { item: BatchItemResult }) {
    const st = statusText(item);
    const tappable = item.status === "completed" && !!item.scanId;
    return (
      <Pressable style={styles.itemCard} onPress={() => openItem(item)} disabled={!tappable}>
        <Image source={{ uri: item.imageUri }} style={styles.thumb} />
        <View style={styles.itemBody}>
          <Text style={[styles.itemTitle, { color: st.color }]} numberOfLines={1}>
            {st.text}
          </Text>
          <View style={styles.metaRow}>
            {item.status === "completed" && item.confidencePct != null && item.band && (
              <View style={[styles.bandPill, { backgroundColor: BAND_COLOR[item.band] }]}>
                <Text style={styles.bandPillText}>{item.confidencePct}%</Text>
              </View>
            )}
            {item.valueLabel && <Text style={styles.valueText}>{item.valueLabel}</Text>}
            <Text style={styles.typeText}>
              {item.scanType === "deep" ? L("Deep", "Qoto dheer") : L("Standard", "Caadi")}
            </Text>
          </View>
        </View>
        {tappable && <Ionicons name="chevron-forward" size={20} color="#8A8A8E" />}
      </Pressable>
    );
  }

  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={[styles.listContent, { paddingBottom: 16 + insets.bottom }]}
      data={items}
      keyExtractor={(item, idx) => item.scanId ?? `${idx}-${item.imageUri}`}
      renderItem={renderItem}
      ListHeaderComponent={
        <View style={styles.header}>
          <Text style={styles.headerTitle}>💎 {L("Batch Results", "Natiijooyinka Batch")}</Text>
          <Text style={styles.headerCount}>
            {items.length} {L("items", "shay")} · {completed} {L("completed", "dhammaystiran")}
            {failed > 0 ? ` · ${failed} ${L("failed", "fashilmay")}` : ""}
            {skipped > 0 ? ` · ${skipped} ${L("skipped", "la booday")}` : ""}
          </Text>

          {reason && (
            <View style={styles.stopBanner}>
              <Ionicons name="information-circle" size={18} color="#C9A227" />
              <Text style={styles.stopBannerText}>
                {reason === "deep_credits_exhausted"
                  ? L(
                      "Your Deep Scan credits ran out — the remaining photos were not scanned.",
                      "Credits-kaaga Deep Scan wuu dhammaaday — sawirradii hadhay lama baarin.",
                    )
                  : L(
                      "Your daily Standard Scan limit was reached — the remaining photos were not scanned.",
                      "Xadka Standard Scan ee maalintaada waa la gaadhay — sawirradii hadhay lama baarin.",
                    )}
              </Text>
              {EXTERNAL_PURCHASES_ENABLED && reason === "deep_credits_exhausted" && (
                <Pressable style={styles.stopBannerButton} onPress={() => Linking.openURL(PAYMENT_URL)}>
                  <Text style={styles.stopBannerButtonText}>{L("Unlock more on the website", "Ka fur website-ka")}</Text>
                </Pressable>
              )}
            </View>
          )}

          <View style={styles.actionRow}>
            <Pressable style={styles.shareButton} onPress={shareSummary} disabled={sharing}>
              {sharing ? (
                <ActivityIndicator color="#0B0B0C" size="small" />
              ) : (
                <>
                  <Ionicons name="share-social-outline" size={16} color="#0B0B0C" />
                  <Text style={styles.shareButtonText}>{L("Share summary", "La wadaag soo koobidda")}</Text>
                </>
              )}
            </Pressable>
            {canPdf && (
              <Pressable style={styles.pdfButton} onPress={exportPdf} disabled={pdfBusy}>
                {pdfBusy ? (
                  <ActivityIndicator color="#C9A227" size="small" />
                ) : (
                  <>
                    <Ionicons name="document-text-outline" size={16} color="#C9A227" />
                    <Text style={styles.pdfButtonText}>{L("Export PDF", "Soo Deji PDF")}</Text>
                  </>
                )}
              </Pressable>
            )}
          </View>
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0B0B0C" },
  listContent: { padding: 16, gap: 10 },
  header: { paddingVertical: 8, paddingHorizontal: 4, marginBottom: 4, gap: 10 },
  headerTitle: { fontSize: 22, fontWeight: "800", color: "#C9A227" },
  headerCount: { fontSize: 13, color: "#8A8A8E", marginTop: 2 },
  stopBanner: {
    backgroundColor: "rgba(201,162,39,0.12)",
    borderWidth: 1,
    borderColor: "#C9A227",
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  stopBannerText: { color: "#E8E2D2", fontSize: 13, lineHeight: 18 },
  stopBannerButton: {
    alignSelf: "flex-start",
    backgroundColor: "#C9A227",
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  stopBannerButtonText: { color: "#0B0B0C", fontWeight: "800", fontSize: 13 },
  actionRow: { flexDirection: "row", gap: 10 },
  shareButton: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#C9A227",
    borderRadius: 999,
    paddingVertical: 12,
  },
  shareButtonText: { color: "#0B0B0C", fontWeight: "800", fontSize: 13 },
  pdfButton: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: "#C9A227",
    borderRadius: 999,
    paddingVertical: 12,
  },
  pdfButtonText: { color: "#C9A227", fontWeight: "800", fontSize: 13 },
  itemCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#1A1A1D",
    borderRadius: 14,
    padding: 12,
  },
  thumb: { width: 56, height: 56, borderRadius: 10, backgroundColor: "#2A2A2C" },
  itemBody: { flex: 1, gap: 4 },
  itemTitle: { fontSize: 15, fontWeight: "600" },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  bandPill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  bandPillText: { fontSize: 11, color: "#0B0B0C", fontWeight: "800" },
  valueText: { fontSize: 12, color: "#C9A227", fontWeight: "700" },
  typeText: { fontSize: 11, color: "#8A8A8E" },
});

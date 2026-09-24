// Issue 1 (2026-09-24 audit) — TRUE Phase 15 region-wide discovery, mobile
// trigger. This app's map is a custom offline canvas (mapScene.ts), not
// react-native-maps, so a freehand polygon-drawing tool is a separate,
// dedicated follow-up (not itemized in the audit's own test/file list,
// which is entirely backend). This screen's input is the smallest REAL
// polygon a manager can specify without one: two opposite corners of a
// rectangle. discover-region-targets treats it like any other GeoJSON
// polygon — it has no special-case for rectangles.
import React, { useState } from "react";
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, TextInput, Alert } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, spacing } from "../../../../lib/theme";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { discoverRegionTargets, type DiscoverRegionResult, type RegionCluster } from "../../../../lib/enterprise/missions";
import { bandToSimpleLevel, levelLabel, topReasonSentence, LEVEL_EMOJI } from "../../../../lib/enterprise/plainLanguage";

export default function DiscoverRegionScreen() {
  const { missionId, commodity } = useLocalSearchParams<{ missionId: string; commodity?: string }>();
  const { i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const so = i18n.language === "so";

  const [latA, setLatA] = useState("");
  const [lngA, setLngA] = useState("");
  const [latB, setLatB] = useState("");
  const [lngB, setLngB] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DiscoverRegionResult | null>(null);

  const nA = { lat: Number(latA), lng: Number(lngA) };
  const nB = { lat: Number(latB), lng: Number(lngB) };
  const validCorner = (p: { lat: number; lng: number }) =>
    Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180;
  const canScan = validCorner(nA) && validCorner(nB) && (nA.lat !== nB.lat || nA.lng !== nB.lng);

  async function handleScan() {
    if (!missionId || !canScan) return;
    setLoading(true);
    setResult(null);
    try {
      const r = await discoverRegionTargets(missionId, [nA, nB], commodity ? { commodity } : {});
      setResult(r);
    } catch (err) {
      Alert.alert(so ? "Khalad" : "Error", (err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>{so ? "Sahami Gobolka" : "Scan a Region"}</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.introText}>
          {so
            ? "Geli laba geesood oo isku-mid ah (koonaha waqooyi-galbeed iyo koonaha koonfur-bari) si loo qeexo gobolka la sahamin doono."
            : "Enter two opposite corners (NW and SE) to define the rectangle to scan."}
        </Text>
        {commodity && (
          <Text style={styles.commodityBadge}>
            {so ? `Raadinta: ${commodity}` : `Looking for: ${commodity}`}
          </Text>
        )}

        <Card style={styles.card}>
          <Text style={styles.sectionTitle}>{so ? "Geeska 1" : "Corner 1"}</Text>
          <View style={styles.row}>
            <TextInput
              style={styles.input}
              placeholder="latitude"
              placeholderTextColor={colors.textFaint}
              keyboardType="numbers-and-punctuation"
              value={latA}
              onChangeText={setLatA}
            />
            <TextInput
              style={styles.input}
              placeholder="longitude"
              placeholderTextColor={colors.textFaint}
              keyboardType="numbers-and-punctuation"
              value={lngA}
              onChangeText={setLngA}
            />
          </View>
          <Text style={styles.sectionTitle}>{so ? "Geeska 2" : "Corner 2"}</Text>
          <View style={styles.row}>
            <TextInput
              style={styles.input}
              placeholder="latitude"
              placeholderTextColor={colors.textFaint}
              keyboardType="numbers-and-punctuation"
              value={latB}
              onChangeText={setLatB}
            />
            <TextInput
              style={styles.input}
              placeholder="longitude"
              placeholderTextColor={colors.textFaint}
              keyboardType="numbers-and-punctuation"
              value={lngB}
              onChangeText={setLngB}
            />
          </View>
          <Button
            title={loading ? "…" : (so ? "Bilow Sahaminta" : "Scan Region")}
            onPress={handleScan}
            disabled={!canScan || loading}
            style={styles.scanButton}
          />
        </Card>

        {loading && (
          <View style={styles.centerFill}><ActivityIndicator color={colors.gold} /></View>
        )}

        {result && (
          <>
            <Text style={styles.summaryText}>
              {so
                ? `${result.totalCellsInPolygon} unug ayaa la sahamiyay, ${result.clusters.length} deeq ayaa la helay`
                : `${result.totalCellsInPolygon} cells scanned, ${result.clusters.length} candidate area(s) found`}
            </Text>
            {result.clusters.length === 0 && (
              <Text style={styles.mutedText}>
                {so ? "Wax deeq ah lagama helin gobolkan." : "No promising candidates found in this region."}
              </Text>
            )}
            {result.clusters.map((c) => <ClusterCard key={c.clusterId} cluster={c} so={so} />)}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function ClusterCard({ cluster, so }: { cluster: RegionCluster; so: boolean }) {
  const level = bandToSimpleLevel(cluster.band);
  const sentence = topReasonSentence(cluster.reasons, so);
  return (
    <Card style={styles.clusterCard}>
      <View style={styles.clusterRow}>
        <Text style={styles.emoji}>{LEVEL_EMOJI[level]}</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.clusterLevel}>{levelLabel(level, so)}</Text>
          <Text style={styles.mutedText}>
            {cluster.cellCount} {so ? "unug" : "cells"} · {cluster.center.lat.toFixed(4)}, {cluster.center.lng.toFixed(4)}
          </Text>
          {sentence && <Text style={styles.sentence}>{sentence}</Text>}
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  title: { color: colors.text, fontSize: 18, fontWeight: "800" },
  centerFill: { alignItems: "center", justifyContent: "center", paddingVertical: spacing.lg },
  body: { padding: spacing.md, gap: spacing.sm, paddingBottom: 60 },
  introText: { color: colors.textMuted, fontSize: 13, marginBottom: spacing.sm },
  commodityBadge: { color: colors.gold, fontSize: 12, fontWeight: "700", marginBottom: spacing.sm },
  card: { gap: spacing.xs, marginBottom: spacing.sm },
  sectionTitle: { color: colors.gold, fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.4, marginTop: spacing.xs },
  row: { flexDirection: "row", gap: spacing.sm },
  input: { flex: 1, backgroundColor: colors.surfaceAlt, color: colors.text, borderRadius: 8, paddingHorizontal: spacing.sm, paddingVertical: 8, fontSize: 14 },
  scanButton: { marginTop: spacing.sm },
  summaryText: { color: colors.text, fontSize: 13, fontWeight: "700", marginTop: spacing.sm },
  mutedText: { color: colors.textFaint, fontSize: 12 },
  clusterCard: { marginBottom: spacing.sm },
  clusterRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  emoji: { fontSize: 28 },
  clusterLevel: { color: colors.text, fontSize: 15, fontWeight: "800" },
  sentence: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
});

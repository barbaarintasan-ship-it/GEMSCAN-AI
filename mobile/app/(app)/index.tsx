import React, { useLayoutEffect, useCallback } from "react";
import { View, Text, Pressable, StyleSheet, BackHandler, Platform, ScrollView } from "react-native";
import { useRouter, useNavigation, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useSubscriptionStatus } from "../../lib/subscription";
import { useAuth } from "../../lib/auth";
import { setAppLanguage } from "../../lib/i18n";
import { PremiumGate } from "../../components/PremiumGate";
import { CommunityStats } from "../../components/CommunityStats";

// What the scanner identifies — shown as coloured gem marks. Names are the real
// gem/material names; the count below is deliberately honest (see the note).
type Gem = { label: string; color: string; icon: keyof typeof Ionicons.glyphMap };
const GEMS: Gem[] = [
  { label: "Diamond", color: "#e4e8f5", icon: "diamond" },
  { label: "Ruby", color: "#e0115f", icon: "diamond" },
  { label: "Emerald", color: "#12b981", icon: "diamond" },
  { label: "Sapphire", color: "#2f6bd6", icon: "diamond" },
  { label: "Amethyst", color: "#9b6dd6", icon: "diamond" },
  { label: "Opal", color: "#8fe0d0", icon: "diamond" },
  { label: "Topaz", color: "#f0a848", icon: "diamond" },
  { label: "Garnet", color: "#a01d34", icon: "diamond" },
  { label: "Aquamarine", color: "#6fd6cc", icon: "diamond" },
  { label: "Citrine", color: "#e6c229", icon: "diamond" },
  { label: "Jade", color: "#2fae74", icon: "diamond" },
  { label: "Peridot", color: "#9bc400", icon: "diamond" },
  { label: "Gold", color: "#d4af37", icon: "ellipse" },
  { label: "Silver", color: "#cfd4da", icon: "ellipse" },
  { label: "Coins", color: "#c9a227", icon: "ellipse" },
  { label: "Artifacts", color: "#b08d57", icon: "cube" },
];

export default function HomeScreen() {
  const { data, isLoading, refetch } = useSubscriptionStatus();
  const router = useRouter();
  const navigation = useNavigation();
  const { t, i18n } = useTranslation();
  const { session } = useAuth();

  // Refresh the Deep Scan credit balance every time the home screen is focused
  // (e.g. returning from a scan), so a just-used Deep Scan shows 99 immediately
  // instead of the cached 100.
  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch]),
  );
  const insets = useSafeAreaInsets();
  const so = i18n.language === "so";

  const fullName =
    (session?.user?.user_metadata?.display_name as string | undefined)?.trim() || "";
  const firstName = fullName ? fullName.split(/\s+/)[0] : "";
  const greeting = so ? "Ku soo dhawoow" : "Welcome";

  // Header: language toggle (top-right) + exit + collection + settings.
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={styles.headerActions}>
          <Pressable onPress={() => setAppLanguage(so ? "en" : "so")} hitSlop={8} style={styles.langPill} accessibilityLabel="Change language">
            <Ionicons name="language-outline" size={15} color="#0B0B0C" />
            <Text style={styles.langText}>{so ? "SO" : "EN"}</Text>
          </Pressable>
          {Platform.OS === "android" && (
            <Pressable onPress={() => BackHandler.exitApp()} hitSlop={8} accessibilityLabel="Exit app">
              <Ionicons name="exit-outline" size={22} color="#E4685D" />
            </Pressable>
          )}
          <Pressable onPress={() => router.push("/(app)/history")} hitSlop={8} accessibilityLabel={t("home.myCollection")}>
            <Ionicons name="albums-outline" size={22} color="#F5F1E8" />
          </Pressable>
          <Pressable onPress={() => router.push("/(app)/settings")} hitSlop={8} accessibilityLabel={t("home.settings")}>
            <Ionicons name="settings-outline" size={22} color="#F5F1E8" />
          </Pressable>
        </View>
      ),
    });
  }, [navigation, router, t, so]);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.container, { paddingBottom: 40 + insets.bottom }]}
    >
      <Text style={styles.logo}>💎 GemScan</Text>
      {firstName ? (
        <Text style={styles.greeting}>
          {greeting}, <Text style={styles.greetingName}>{firstName}</Text> 👋
        </Text>
      ) : null}
      <Text style={styles.subtitle}>{t("home.subtitle")}</Text>

      {!isLoading && (
        <Text style={styles.tierBadge}>
          {t("home.currentPlan", { tier: data?.tier ?? "free" })}
        </Text>
      )}
      {!isLoading && data && (
        <Text style={styles.deepBadge}>
          💎 {data.deepScan.remaining}{" "}
          {i18n.language === "so" ? "Deep Scan ayaa kuu hadhay" : "Deep Scans left"}
        </Text>
      )}

      <Pressable style={styles.scanButton} onPress={() => router.push("/(app)/scan/live")}>
        <Ionicons name="scan-outline" size={20} color="#0B0B0C" />
        <Text style={styles.scanButtonText}>{t("home.startLiveScan")}</Text>
      </Pressable>

      <Pressable style={styles.secondaryButton} onPress={() => router.push("/(app)/scan/upload")}>
        <Ionicons name="images-outline" size={18} color="#F5F1E8" />
        <Text style={styles.secondaryButtonText}>{t("home.uploadImages")}</Text>
      </Pressable>

      <Pressable style={styles.collectionButton} onPress={() => router.push("/(app)/history")}>
        <Ionicons name="albums-outline" size={18} color="#C9A227" />
        <Text style={styles.collectionButtonText}>{t("home.myCollection")}</Text>
      </Pressable>

      {/* Gemstone showcase */}
      <View style={styles.showcase}>
        <Text style={styles.showcaseTitle}>{so ? "Waxaan aqoonsan karnaa" : "We can identify"}</Text>
        <View style={styles.grid}>
          {GEMS.map((g) => (
            <View key={g.label} style={styles.gem}>
              <Ionicons name={g.icon} size={24} color={g.color} />
              <Text style={styles.gemLabel}>{g.label}</Text>
            </View>
          ))}
        </View>
        {/* Honest scope: the IMA recognises ~5,900 mineral species — the real,
            citable figure. No fabricated numbers. */}
        <View style={styles.statRow}>
          <Text style={styles.statNumber}>5,900+</Text>
          <Text style={styles.statLabel}>
            {so ? "nooc dhagax & macdan" : "gemstone & mineral types"}
          </Text>
        </View>
        <Text style={styles.showcaseMore}>
          {so
            ? "…iyo dahab, qalin, qadaadiic & shay-taariikheed"
            : "…plus gold, silver, coins & artifacts"}
        </Text>
      </View>

      <PremiumGate requiredTier="premium" featureName="Deep Scan (advanced identification)">
        <Text style={styles.body}>{t("home.deepScanUnlocked")}</Text>
      </PremiumGate>

      {/* Live community counters (registered users + confirmed valuable gems). */}
      <CommunityStats />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0B0B0C" },
  container: { padding: 24, gap: 14, paddingBottom: 40 },
  headerActions: { flexDirection: "row", gap: 16, paddingRight: 4, alignItems: "center" },
  langPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: "#C9A227",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  langText: { color: "#0B0B0C", fontWeight: "800", fontSize: 12 },

  logo: { fontSize: 26, fontWeight: "800", color: "#C9A227", marginTop: 4 },
  greeting: { fontSize: 18, color: "#F5F1E8", fontWeight: "600" },
  greetingName: { color: "#C9A227", fontWeight: "800" },
  subtitle: { fontSize: 15, color: "#C9C9CC", lineHeight: 21 },
  body: { fontSize: 14, color: "#C9C9CC", lineHeight: 20 },
  tierBadge: { color: "#C9A227", fontWeight: "600", fontSize: 13 },
  deepBadge: { color: "#F5F1E8", fontWeight: "800", fontSize: 15, marginTop: 2 },

  scanButton: {
    flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 8,
    backgroundColor: "#C9A227", borderRadius: 999, paddingVertical: 16, marginTop: 4,
  },
  scanButtonText: { color: "#0B0B0C", fontWeight: "700", fontSize: 16 },
  secondaryButton: {
    flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 8,
    borderWidth: 1, borderColor: "#8A8A8E", borderRadius: 999, paddingVertical: 14,
  },
  secondaryButtonText: { color: "#F5F1E8", fontWeight: "700", fontSize: 15 },
  collectionButton: {
    flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 8, paddingVertical: 10,
  },
  collectionButtonText: { color: "#C9A227", fontWeight: "600", fontSize: 15 },

  showcase: {
    backgroundColor: "#141315", borderRadius: 16, borderWidth: 1, borderColor: "#242123",
    padding: 16, marginTop: 6, gap: 12,
  },
  showcaseTitle: {
    fontSize: 12, color: "#8A8A8E", textTransform: "uppercase", letterSpacing: 1,
    fontWeight: "700", textAlign: "center",
  },
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 10 },
  gem: { width: 70, alignItems: "center", gap: 5, paddingVertical: 9, backgroundColor: "#1C1A1D", borderRadius: 12 },
  gemLabel: { fontSize: 10, color: "#C9C9CC", fontWeight: "600" },
  statRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "center", gap: 8, marginTop: 2 },
  statNumber: { fontSize: 26, fontWeight: "900", color: "#C9A227" },
  statLabel: { fontSize: 13, color: "#C9C9CC" },
  showcaseMore: { fontSize: 12, color: "#8A8A8E", textAlign: "center", fontStyle: "italic" },
});

import React, { useLayoutEffect } from "react";
import { View, Text, Pressable, StyleSheet, BackHandler, Platform, ScrollView } from "react-native";
import { useRouter, useNavigation } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useSubscriptionStatus } from "../../lib/subscription";
import { useAuth } from "../../lib/auth";
import { PremiumGate } from "../../components/PremiumGate";

// A showcase of what the scanner can identify — fills the home screen and tells
// the user, at a glance, what the app is for.
const SHOWCASE: { icon: string; label: string }[] = [
  { icon: "💎", label: "Diamond" },
  { icon: "❤️", label: "Ruby" },
  { icon: "💚", label: "Emerald" },
  { icon: "💙", label: "Sapphire" },
  { icon: "🌈", label: "Opal" },
  { icon: "💜", label: "Amethyst" },
  { icon: "🔶", label: "Topaz" },
  { icon: "🟠", label: "Garnet" },
  { icon: "🔷", label: "Aquamarine" },
  { icon: "🟩", label: "Jade" },
  { icon: "⚪", label: "Quartz" },
  { icon: "🟡", label: "Citrine" },
  { icon: "🥇", label: "Gold" },
  { icon: "🥈", label: "Silver" },
  { icon: "🪙", label: "Coins" },
  { icon: "🏺", label: "Artifacts" },
];

export default function HomeScreen() {
  const { data, isLoading } = useSubscriptionStatus();
  const router = useRouter();
  const navigation = useNavigation();
  const { t, i18n } = useTranslation();
  const { session } = useAuth();

  const fullName =
    (session?.user?.user_metadata?.display_name as string | undefined)?.trim() || "";
  const firstName = fullName ? fullName.split(/\s+/)[0] : "";
  const greeting = i18n.language === "so" ? "Ku soo dhawoow" : "Welcome";

  const handleExit = () => {
    BackHandler.exitApp();
  };

  // Header: Exit (top, visible) + collection + settings.
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={styles.headerActions}>
          {Platform.OS === "android" && (
            <Pressable onPress={handleExit} hitSlop={8} accessibilityLabel="Exit app">
              <Ionicons name="exit-outline" size={22} color="#E4685D" />
            </Pressable>
          )}
          <Pressable
            onPress={() => router.push("/(app)/history")}
            hitSlop={8}
            accessibilityLabel={t("home.myCollection")}
          >
            <Ionicons name="albums-outline" size={22} color="#F5F1E8" />
          </Pressable>
          <Pressable
            onPress={() => router.push("/(app)/settings")}
            hitSlop={8}
            accessibilityLabel={t("home.settings")}
          >
            <Ionicons name="settings-outline" size={22} color="#F5F1E8" />
          </Pressable>
        </View>
      ),
    });
  }, [navigation, router, t]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      {/* Logo + greeting */}
      <View style={styles.brandRow}>
        <Text style={styles.logo}>💎 GemScan</Text>
      </View>
      {firstName ? (
        <Text style={styles.greeting}>
          {greeting}, <Text style={styles.greetingName}>{firstName}</Text> 👋
        </Text>
      ) : null}
      <Text style={styles.subtitle}>{t("home.subtitle")}</Text>

      {!isLoading && (
        <Text style={styles.tierBadge}>
          {t("home.currentPlan", { tier: data?.tier ?? "free" })}
          {" — "}
          {data?.features.dailyScanLimit != null
            ? t("home.scansPerDay", { count: data.features.dailyScanLimit })
            : t("home.unlimitedScans")}
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

      {/* Gemstone showcase — what the app can identify */}
      <View style={styles.showcase}>
        <Text style={styles.showcaseTitle}>
          {i18n.language === "so" ? "Waxaan aqoonsan karnaa" : "We can identify"}
        </Text>
        <View style={styles.grid}>
          {SHOWCASE.map((g) => (
            <View key={g.label} style={styles.gem}>
              <Text style={styles.gemIcon}>{g.icon}</Text>
              <Text style={styles.gemLabel}>{g.label}</Text>
            </View>
          ))}
        </View>
        <Text style={styles.showcaseMore}>
          {i18n.language === "so" ? "…iyo kumanaan kale" : "…and thousands more"}
        </Text>
      </View>

      <PremiumGate requiredTier="premium" featureName="Deep Scan (advanced identification)">
        <Text style={styles.body}>{t("home.deepScanUnlocked")}</Text>
      </PremiumGate>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0B0B0C" },
  container: { padding: 24, gap: 14, paddingBottom: 40 },
  headerActions: { flexDirection: "row", gap: 18, paddingRight: 4, alignItems: "center" },

  brandRow: { flexDirection: "row", alignItems: "center", marginTop: 4 },
  logo: { fontSize: 26, fontWeight: "800", color: "#C9A227" },
  greeting: { fontSize: 18, color: "#F5F1E8", fontWeight: "600" },
  greetingName: { color: "#C9A227", fontWeight: "800" },
  subtitle: { fontSize: 15, color: "#C9C9CC", lineHeight: 21 },
  body: { fontSize: 14, color: "#C9C9CC", lineHeight: 20 },
  tierBadge: { color: "#C9A227", fontWeight: "600", fontSize: 13 },

  scanButton: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#C9A227",
    borderRadius: 999,
    paddingVertical: 16,
    marginTop: 4,
  },
  scanButtonText: { color: "#0B0B0C", fontWeight: "700", fontSize: 16 },
  secondaryButton: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: "#8A8A8E",
    borderRadius: 999,
    paddingVertical: 14,
  },
  secondaryButtonText: { color: "#F5F1E8", fontWeight: "700", fontSize: 15 },
  collectionButton: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    paddingVertical: 10,
  },
  collectionButtonText: { color: "#C9A227", fontWeight: "600", fontSize: 15 },

  showcase: {
    backgroundColor: "#141315",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#242123",
    padding: 16,
    marginTop: 6,
    gap: 12,
  },
  showcaseTitle: {
    fontSize: 12,
    color: "#8A8A8E",
    textTransform: "uppercase",
    letterSpacing: 1,
    fontWeight: "700",
    textAlign: "center",
  },
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 10 },
  gem: {
    width: 70,
    alignItems: "center",
    gap: 4,
    paddingVertical: 8,
    backgroundColor: "#1C1A1D",
    borderRadius: 12,
  },
  gemIcon: { fontSize: 24 },
  gemLabel: { fontSize: 10, color: "#C9C9CC", fontWeight: "600" },
  showcaseMore: { fontSize: 12, color: "#8A8A8E", textAlign: "center", fontStyle: "italic" },
});

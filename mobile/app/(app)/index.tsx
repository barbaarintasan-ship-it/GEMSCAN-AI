import React, { useLayoutEffect } from "react";
import { View, Text, Pressable, StyleSheet, BackHandler, Platform } from "react-native";
import { useRouter, useNavigation } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useSubscriptionStatus } from "../../lib/subscription";
import { PremiumGate } from "../../components/PremiumGate";

export default function HomeScreen() {
  const { data, isLoading } = useSubscriptionStatus();
  const router = useRouter();
  const navigation = useNavigation();
  const { t } = useTranslation();

  // Close the app. BackHandler.exitApp() is the Android way to finish the
  // activity; iOS has no supported programmatic exit (Apple rejects it), so the
  // button is only shown on Android.
  const handleExit = () => {
    BackHandler.exitApp();
  };

  // Header actions to reach the two new foundation screens. Set here so the
  // icons can navigate with the screen's router instance.
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={styles.headerActions}>
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
    <View style={styles.container}>
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
        <Text style={styles.scanButtonText}>{t("home.startLiveScan")}</Text>
      </Pressable>

      <Pressable style={styles.secondaryButton} onPress={() => router.push("/(app)/scan/upload")}>
        <Text style={styles.secondaryButtonText}>{t("home.uploadImages")}</Text>
      </Pressable>

      <Pressable style={styles.collectionButton} onPress={() => router.push("/(app)/history")}>
        <Ionicons name="albums-outline" size={18} color="#C9A227" />
        <Text style={styles.collectionButtonText}>{t("home.myCollection")}</Text>
      </Pressable>

      {/*
        Note this component never sells anything — it only reads entitlement
        and, if not entitled, links out to the website. The multi-model
        "Deep Scan" ensemble itself is enforced server-side in
        orchestrate-scan (see providers/*.ts requiresEnsembleTier), not just
        gated here in the UI.
      */}
      <PremiumGate requiredTier="premium" featureName="Deep Scan (advanced identification)">
        <Text style={styles.body}>{t("home.deepScanUnlocked")}</Text>
      </PremiumGate>

      {Platform.OS === "android" && (
        <Pressable style={styles.exitButton} onPress={handleExit} accessibilityLabel="Exit app">
          <Ionicons name="exit-outline" size={18} color="#E4685D" />
          <Text style={styles.exitButtonText}>Exit app</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, backgroundColor: "#0B0B0C", gap: 16 },
  headerActions: { flexDirection: "row", gap: 20, paddingRight: 4 },
  subtitle: { fontSize: 15, color: "#C9C9CC", lineHeight: 21 },
  body: { fontSize: 14, color: "#C9C9CC", lineHeight: 20 },
  tierBadge: {
    color: "#C9A227",
    fontWeight: "600",
    fontSize: 13,
  },
  scanButton: {
    backgroundColor: "#C9A227",
    borderRadius: 999,
    paddingVertical: 16,
    alignItems: "center",
  },
  scanButtonText: { color: "#0B0B0C", fontWeight: "700", fontSize: 16 },
  secondaryButton: {
    borderWidth: 1,
    borderColor: "#8A8A8E",
    borderRadius: 999,
    paddingVertical: 14,
    alignItems: "center",
  },
  secondaryButtonText: { color: "#F5F1E8", fontWeight: "700", fontSize: 15 },
  collectionButton: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    paddingVertical: 12,
  },
  collectionButtonText: { color: "#C9A227", fontWeight: "600", fontSize: 15 },
  exitButton: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    paddingVertical: 12,
    marginTop: "auto",
  },
  exitButtonText: { color: "#E4685D", fontWeight: "600", fontSize: 15 },
});

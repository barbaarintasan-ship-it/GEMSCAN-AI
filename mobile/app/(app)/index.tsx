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
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { colors, spacing, radius, type as typo } from "../../lib/theme";
import { isOwnerEmail } from "../../lib/enterpriseSamples";

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
      <Text style={styles.logo}>💎 LuulScan</Text>
      {firstName ? (
        <Text style={styles.greeting}>
          {greeting}, <Text style={styles.greetingName}>{firstName}</Text> 👋
        </Text>
      ) : null}
      <Text style={styles.subtitle}>{t("home.subtitle")}</Text>

      {!isLoading && (
        <Card style={styles.statusCard}>
          <Text style={styles.statusPlan}>{t("home.currentPlan", { tier: data?.tier ?? "free" })}</Text>
          {data && (
            <Text style={styles.statusDeep}>
              💎 {data.deepScan.remaining}{" "}
              {i18n.language === "so" ? "Deep Scan ayaa kuu hadhay" : "Deep Scans left"}
            </Text>
          )}
        </Card>
      )}

      <Button
        title={t("home.startLiveScan")}
        variant="primary"
        icon={<Ionicons name="scan-outline" size={19} color="#0B0B0C" />}
        onPress={() => router.push("/(app)/scan/live")}
        style={styles.primaryAction}
      />

      <View style={styles.actionRow}>
        <Button
          title={t("home.uploadImages")}
          variant="outline"
          icon={<Ionicons name="images-outline" size={16} color={colors.gold} />}
          onPress={() => router.push("/(app)/scan/upload")}
          style={styles.actionHalf}
        />
        <View style={styles.batchWrap}>
          <Button
            title="Batch Scan"
            variant="outline"
            icon={<Ionicons name="layers-outline" size={16} color={colors.gold} />}
            onPress={() => router.push("/(app)/scan/batch")}
            style={styles.actionHalf}
          />
          {!data?.features?.batchScanning && !isLoading && (
            <View style={styles.proBadge}>
              <Text style={styles.proBadgeText}>PRO</Text>
            </View>
          )}
        </View>
      </View>

      <Pressable style={styles.collectionButton} onPress={() => router.push("/(app)/history")} hitSlop={8}>
        <Ionicons name="albums-outline" size={16} color={colors.gold} />
        <Text style={styles.collectionButtonText}>{t("home.myCollection")}</Text>
      </Pressable>

      {/* Enterprise owner beta (Sprint 4.2) — visible only to the owner allowlist. */}
      {isOwnerEmail(session?.user?.email) && (
        <Pressable style={styles.collectionButton} onPress={() => router.push("/(app)/enterprise/samples")} hitSlop={8}>
          <Ionicons name="briefcase-outline" size={16} color={colors.gold} />
          <Text style={styles.collectionButtonText}>Enterprise · Field Samples</Text>
        </Pressable>
      )}

      {/* Exploration Mode.
          Deliberately NOT behind the owner gate that hides Field Samples above.
          That gate exists because Field Samples calls enterprise endpoints, and
          hiding the entry point mirrors the server's requireEnterprise check.
          Exploration Mode calls NO server at all — it runs entirely against the
          bundled offline knowledge pack — so gating it would hide a feature
          without protecting anything. Entitlement (architecture §14.4) is still
          an open decision; when it lands it belongs on the session, not here. */}
      <Pressable style={styles.collectionButton} onPress={() => router.push("/(app)/exploration")} hitSlop={8}>
        <Ionicons name="compass-outline" size={16} color={colors.gold} />
        <Text style={styles.collectionButtonText}>{t("field.title")}</Text>
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
        <Card style={styles.unlockedCard}>
          <Ionicons name="sparkles" size={16} color={colors.gold} />
          <Text style={styles.body}>{t("home.deepScanUnlocked")}</Text>
        </Card>
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

  logo: { fontSize: 27, fontWeight: "800", color: colors.gold, marginTop: 4, letterSpacing: 0.2 },
  greeting: { fontSize: 18, color: colors.text, fontWeight: "600" },
  greetingName: { color: colors.gold, fontWeight: "800" },
  subtitle: { ...typo.body, marginBottom: 2 },
  body: { ...typo.body, flexShrink: 1 },

  statusCard: { paddingVertical: spacing.md, gap: 4 },
  statusPlan: { color: colors.gold, fontWeight: "700", fontSize: 14, textTransform: "capitalize" },
  statusDeep: { color: colors.text, fontWeight: "800", fontSize: 15 },

  primaryAction: { marginTop: spacing.xs },
  actionRow: { flexDirection: "row", gap: spacing.md },
  actionHalf: { flex: 1, paddingHorizontal: spacing.sm },
  batchWrap: { flex: 1, position: "relative" },
  proBadge: {
    position: "absolute",
    top: -8,
    right: -6,
    backgroundColor: colors.gold,
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  proBadgeText: { color: "#0B0B0C", fontWeight: "900", fontSize: 9, letterSpacing: 0.3 },
  collectionButton: {
    flexDirection: "row", justifyContent: "center", alignItems: "center", gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  collectionButtonText: { color: colors.gold, fontWeight: "600", fontSize: 15 },
  unlockedCard: { flexDirection: "row", alignItems: "center", gap: spacing.sm },

  showcase: {
    backgroundColor: colors.surface, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.borderSubtle,
    padding: spacing.lg, marginTop: spacing.xs, gap: spacing.md,
  },
  showcaseTitle: { ...typo.label, textAlign: "center", marginTop: 0, marginBottom: 0 },
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: spacing.sm + 2 },
  gem: {
    width: 70, alignItems: "center", gap: 5, paddingVertical: spacing.sm + 1,
    backgroundColor: colors.surfaceSunken, borderRadius: radius.md,
  },
  gemLabel: { fontSize: 10, color: colors.textMuted, fontWeight: "600" },
  statRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "center", gap: spacing.sm, marginTop: 2 },
  statNumber: { fontSize: 26, fontWeight: "900", color: colors.gold },
  statLabel: { fontSize: 13, color: colors.textMuted },
  showcaseMore: { fontSize: 12, color: colors.textFaint, textAlign: "center", fontStyle: "italic" },
});

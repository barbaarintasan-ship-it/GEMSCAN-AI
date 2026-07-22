// Settings screen: profile, language (English / Somali), privacy, subscription
// status, app info and logout.
//
// Consistent with the payment-separation policy, the Subscription row here only
// *displays* entitlement and hands off to the account screen (which links out
// to the website) — it never contains a purchase flow.
import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  Linking,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import * as Application from "expo-application";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../lib/auth";
import { supabase } from "../../lib/supabase";
import { useSubscriptionStatus } from "../../lib/subscription";
import { setAppLanguage, type AppLanguage } from "../../lib/i18n";
import { getStoredExplanationStyle, setExplanationStyle } from "../../lib/explanationStyle";
import type { ExplanationStyle } from "../../lib/scanUpload";
import { checkForUpdate } from "../../lib/appUpdate";
import { SectionLabel } from "../../components/ui/SectionLabel";
import { colors, spacing, radius } from "../../lib/theme";

export default function SettingsScreen() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { session, signOut } = useAuth();
  const { data: subscription } = useSubscriptionStatus();

  const [displayName, setDisplayName] = useState<string | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [showDataUsage, setShowDataUsage] = useState(false);
  const [explanationStyle, setExplanationStyleState] = useState<ExplanationStyle>("simple");
  const [signingOut, setSigningOut] = useState(false);
  const [versionTaps, setVersionTaps] = useState(0);
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  // Manual "Check for updates": reuses the same launch-time check, on demand.
  async function handleCheckUpdate() {
    if (checkingUpdate) return;
    setCheckingUpdate(true);
    const so = i18n.language === "so";
    try {
      const info = await checkForUpdate();
      if (info?.updateAvailable) {
        Alert.alert(
          so ? "Update ayaa diyaar ah" : "Update available",
          so ? info.message.so : info.message.en,
          [
            { text: so ? "Ka daadi" : "Later", style: "cancel" },
            { text: so ? "Cusboonaysii" : "Update", onPress: () => Linking.openURL(info.storeUrl) },
          ],
        );
      } else {
        Alert.alert(
          so ? "Waad heysaa nooca ugu dambeeya" : "You're up to date",
          so
            ? "Waxaad haysataa nooca LuulScan ugu dambeeyay."
            : "You have the latest version of LuulScan.",
        );
      }
    } finally {
      setCheckingUpdate(false);
    }
  }

  // Hidden Debug/Diagnostics screen: tap the version number 5 times.
  function onVersionTap() {
    const next = versionTaps + 1;
    setVersionTaps(next);
    if (next >= 5) {
      setVersionTaps(0);
      router.push("/(app)/debug");
    }
  }

  useEffect(() => {
    let active = true;
    (async () => {
      const { data } = await supabase
        .from("profiles")
        .select("display_name")
        .eq("id", session?.user.id ?? "")
        .maybeSingle();
      if (active) {
        setDisplayName((data?.display_name as string | null) ?? null);
        setProfileLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [session?.user.id]);

  // The name is stored in auth user_metadata at sign-up (always present) and is
  // ALSO copied into the profiles table by a DB trigger. Prefer user_metadata so
  // the name shows even if the profiles row wasn't populated; fall back to the
  // profiles query. This fixes the "name not displayed" case.
  const metaName =
    ((session?.user?.user_metadata?.display_name as string | undefined) ?? "").trim();
  const shownName = metaName || displayName;

  const currentLang = i18n.language === "so" ? "so" : "en";

  async function handleLanguage(lang: AppLanguage) {
    if (lang === currentLang) return;
    await setAppLanguage(lang);
  }

  useEffect(() => {
    let active = true;
    getStoredExplanationStyle().then((stored) => {
      if (active && stored) setExplanationStyleState(stored);
    });
    return () => {
      active = false;
    };
  }, []);

  async function handleExplanationStyle(style: ExplanationStyle) {
    if (style === explanationStyle) return;
    setExplanationStyleState(style);
    await setExplanationStyle(style);
  }

  async function handleLogout() {
    setSigningOut(true);
    await signOut();
    // The root auth gate redirects to /(auth)/login once the session clears.
  }

  // Show version name + build number, e.g. "1.0.1 (31)". The build number is
  // the Android versionCode EAS auto-increments each build — the value the
  // update check actually compares against app_config.latest_build.
  const versionName = Constants.expoConfig?.version ?? "0.1.0";
  const buildNumber = Application.nativeBuildVersion;
  const appVersion = buildNumber ? `${versionName} (${buildNumber})` : versionName;
  const displayNameOrEmail = shownName || session?.user.email || "";
  const avatarInitial = displayNameOrEmail.trim().charAt(0).toUpperCase() || "?";

  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, { paddingBottom: 40 + insets.bottom }]}>
      {/* Profile header — tap to edit name / phone / country / city. */}
      <Pressable
        style={styles.profileHeader}
        onPress={() => router.push("/(app)/edit-profile")}
        accessibilityRole="button"
        accessibilityLabel={i18n.language === "so" ? "Wax ka beddel profile-ka" : "Edit profile"}
      >
        <View style={styles.avatarCircle}>
          <Text style={styles.avatarInitial}>{avatarInitial}</Text>
        </View>
        <View style={styles.profileHeaderText}>
          <Text style={styles.profileName} numberOfLines={1}>
            {shownName || (profileLoading ? "…" : t("settings.notSet"))}
          </Text>
          <Text style={styles.profileEmail} numberOfLines={1}>
            {session?.user.email ?? "—"}
          </Text>
        </View>
        <View style={styles.editPill}>
          <Ionicons name="create-outline" size={15} color={colors.gold} />
          <Text style={styles.editPillText}>{i18n.language === "so" ? "Wax ka beddel" : "Edit"}</Text>
        </View>
      </Pressable>

      {/* Language */}
      <SectionLabel>{t("settings.languageSection")}</SectionLabel>
      <View style={styles.card}>
        <Pressable style={styles.selectRow} onPress={() => handleLanguage("en")}>
          <Text style={styles.rowValue}>{t("settings.english")}</Text>
          {currentLang === "en" && <Ionicons name="checkmark" size={20} color="#C9A227" />}
        </Pressable>
        <View style={styles.divider} />
        <Pressable style={styles.selectRow} onPress={() => handleLanguage("so")}>
          <Text style={styles.rowValue}>{t("settings.somali")}</Text>
          {currentLang === "so" && <Ionicons name="checkmark" size={20} color="#C9A227" />}
        </Pressable>
      </View>

      {/* Explanation Style (Dual Explanation Modes) */}
      <SectionLabel>{t("settings.explanationStyleSection")}</SectionLabel>
      <View style={styles.card}>
        <Pressable style={styles.selectRow} onPress={() => handleExplanationStyle("simple")}>
          <View style={styles.rowLeft}>
            <Text style={styles.rowValue}>{t("settings.explanationSimple")}</Text>
          </View>
          {explanationStyle === "simple" && <Ionicons name="checkmark" size={20} color="#C9A227" />}
        </Pressable>
        <Text style={styles.privacyBody}>{t("settings.explanationSimpleDesc")}</Text>
        <View style={styles.divider} />
        <Pressable style={styles.selectRow} onPress={() => handleExplanationStyle("expert")}>
          <View style={styles.rowLeft}>
            <Text style={styles.rowValue}>{t("settings.explanationExpert")}</Text>
          </View>
          {explanationStyle === "expert" && <Ionicons name="checkmark" size={20} color="#C9A227" />}
        </Pressable>
        <Text style={styles.privacyBody}>{t("settings.explanationExpertDesc")}</Text>
      </View>

      {/* Privacy */}
      <SectionLabel>{t("settings.privacySection")}</SectionLabel>
      <View style={styles.card}>
        <Pressable style={styles.selectRow} onPress={() => setShowDataUsage((v) => !v)}>
          <View style={styles.rowLeft}>
            <Ionicons name="shield-checkmark-outline" size={18} color={colors.textFaint} />
            <Text style={styles.rowValue}>{t("settings.howYourDataIsUsed")}</Text>
          </View>
          <Ionicons
            name={showDataUsage ? "chevron-up" : "chevron-down"}
            size={18}
            color="#8A8A8E"
          />
        </Pressable>
        {showDataUsage && (
          <Text style={styles.privacyBody}>{t("privacy.dataUsageBody")}</Text>
        )}
        <View style={styles.divider} />
        <Pressable
          style={styles.selectRow}
          onPress={() => Linking.openURL("https://barbaarintasan.com/gemscanprivacy")}
        >
          <View style={styles.rowLeft}>
            <Ionicons name="document-text-outline" size={18} color={colors.textFaint} />
            <Text style={styles.rowValue}>{t("settings.privacyPolicy")}</Text>
          </View>
          <Ionicons name="open-outline" size={18} color="#8A8A8E" />
        </Pressable>
      </View>

      {/* Subscription */}
      <SectionLabel>{t("settings.subscriptionSection")}</SectionLabel>
      <View style={styles.card}>
        <Pressable style={styles.selectRow} onPress={() => router.push("/(app)/account")}>
          <View style={styles.rowLeft}>
            <Ionicons name="card-outline" size={18} color={colors.textFaint} />
            <Text style={styles.rowValue}>{t("settings.manageSubscription")}</Text>
          </View>
          <View style={styles.rowRight}>
            <Text style={styles.tierText}>{subscription?.tier ?? "free"}</Text>
            <Ionicons name="chevron-forward" size={18} color="#8A8A8E" />
          </View>
        </Pressable>
      </View>

      {/* App information */}
      <SectionLabel>{t("settings.aboutSection")}</SectionLabel>
      <View style={styles.card}>
        <Pressable style={styles.row} onPress={onVersionTap}>
          <View style={styles.rowLeft}>
            <Ionicons name="information-circle-outline" size={18} color={colors.textFaint} />
            <Text style={styles.rowLabel}>{t("settings.version")}</Text>
          </View>
          <Text style={styles.rowValue}>{appVersion}</Text>
        </Pressable>
        <View style={styles.rowDivider} />
        <Pressable style={styles.row} onPress={handleCheckUpdate} disabled={checkingUpdate}>
          <View style={styles.rowLeft}>
            <Ionicons name="cloud-download-outline" size={18} color={colors.textFaint} />
            <Text style={styles.rowLabel}>
              {i18n.language === "so" ? "Hubi update cusub" : "Check for updates"}
            </Text>
          </View>
          {checkingUpdate ? (
            <ActivityIndicator size="small" color="#8A8A8E" />
          ) : (
            <Ionicons name="refresh-outline" size={18} color="#C9A227" />
          )}
        </Pressable>
      </View>

      {/* Logout */}
      <Pressable style={styles.logoutButton} onPress={handleLogout} disabled={signingOut}>
        {signingOut ? (
          <ActivityIndicator color="#E5484D" />
        ) : (
          <>
            <Ionicons name="log-out-outline" size={18} color={colors.dangerStrong} />
            <Text style={styles.logoutText}>{t("settings.logout")}</Text>
          </>
        )}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0B0B0C" },
  content: { padding: 20, gap: 8, paddingBottom: 40 },
  profileHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.xl,
    padding: spacing.lg,
    marginBottom: spacing.sm,
  },
  avatarCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.goldSoft,
    borderWidth: 1,
    borderColor: colors.goldBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarInitial: { color: colors.gold, fontSize: 22, fontWeight: "800" },
  profileHeaderText: { flex: 1, gap: 2 },
  profileName: { color: colors.text, fontSize: 18, fontWeight: "800" },
  profileEmail: { color: colors.textFaint, fontSize: 13 },
  editPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.goldSoft,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  editPillText: { color: colors.gold, fontWeight: "800", fontSize: 12 },
  card: { backgroundColor: "#1A1A1D", borderRadius: 14, paddingHorizontal: 16 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 14 },
  selectRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 14,
  },
  rowLeft: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexShrink: 1 },
  rowLabel: { fontSize: 14, color: "#8A8A8E" },
  rowValue: { fontSize: 15, color: "#F5F1E8", flexShrink: 1, textAlign: "right" },
  rowDivider: { height: 1, backgroundColor: "#242123" },
  rowRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  tierText: { fontSize: 14, color: "#C9A227", fontWeight: "600", textTransform: "capitalize" },
  divider: { height: 1, backgroundColor: "#2A2A2C" },
  privacyBody: { fontSize: 13, color: "#C9C9CC", lineHeight: 19, paddingBottom: 14 },
  logoutButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    marginTop: 28,
    paddingVertical: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#E5484D",
  },
  logoutText: { color: "#E5484D", fontWeight: "700", fontSize: 15 },
});

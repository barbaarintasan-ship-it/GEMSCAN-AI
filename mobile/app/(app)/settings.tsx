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
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../lib/auth";
import { supabase } from "../../lib/supabase";
import { useSubscriptionStatus } from "../../lib/subscription";
import { setAppLanguage, type AppLanguage } from "../../lib/i18n";

export default function SettingsScreen() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const { session, signOut } = useAuth();
  const { data: subscription } = useSubscriptionStatus();

  const [displayName, setDisplayName] = useState<string | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [showDataUsage, setShowDataUsage] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [versionTaps, setVersionTaps] = useState(0);

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

  const currentLang = i18n.language === "so" ? "so" : "en";

  async function handleLanguage(lang: AppLanguage) {
    if (lang === currentLang) return;
    await setAppLanguage(lang);
  }

  async function handleLogout() {
    setSigningOut(true);
    await signOut();
    // The root auth gate redirects to /(auth)/login once the session clears.
  }

  const appVersion = Constants.expoConfig?.version ?? "0.1.0";

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {/* Profile */}
      <Text style={styles.sectionLabel}>{t("settings.profileSection")}</Text>
      <View style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>{t("settings.email")}</Text>
          <Text style={styles.rowValue}>{session?.user.email ?? "—"}</Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.row}>
          <Text style={styles.rowLabel}>{t("settings.displayName")}</Text>
          <Text style={styles.rowValue}>
            {profileLoading ? "…" : displayName || t("settings.notSet")}
          </Text>
        </View>
      </View>

      {/* Language */}
      <Text style={styles.sectionLabel}>{t("settings.languageSection")}</Text>
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

      {/* Privacy */}
      <Text style={styles.sectionLabel}>{t("settings.privacySection")}</Text>
      <View style={styles.card}>
        <Pressable style={styles.selectRow} onPress={() => setShowDataUsage((v) => !v)}>
          <Text style={styles.rowValue}>{t("settings.howYourDataIsUsed")}</Text>
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
          onPress={() => Linking.openURL("https://barbaarintasan.com/privacy")}
        >
          <Text style={styles.rowValue}>{t("settings.privacyPolicy")}</Text>
          <Ionicons name="open-outline" size={18} color="#8A8A8E" />
        </Pressable>
      </View>

      {/* Subscription */}
      <Text style={styles.sectionLabel}>{t("settings.subscriptionSection")}</Text>
      <View style={styles.card}>
        <Pressable style={styles.selectRow} onPress={() => router.push("/(app)/account")}>
          <Text style={styles.rowValue}>{t("settings.manageSubscription")}</Text>
          <View style={styles.rowRight}>
            <Text style={styles.tierText}>{subscription?.tier ?? "free"}</Text>
            <Ionicons name="chevron-forward" size={18} color="#8A8A8E" />
          </View>
        </Pressable>
      </View>

      {/* App information */}
      <Text style={styles.sectionLabel}>{t("settings.aboutSection")}</Text>
      <View style={styles.card}>
        <Pressable style={styles.row} onPress={onVersionTap}>
          <Text style={styles.rowLabel}>{t("settings.version")}</Text>
          <Text style={styles.rowValue}>{appVersion}</Text>
        </Pressable>
      </View>

      {/* Logout */}
      <Pressable style={styles.logoutButton} onPress={handleLogout} disabled={signingOut}>
        {signingOut ? (
          <ActivityIndicator color="#E5484D" />
        ) : (
          <Text style={styles.logoutText}>{t("settings.logout")}</Text>
        )}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0B0B0C" },
  content: { padding: 20, gap: 8, paddingBottom: 40 },
  sectionLabel: {
    fontSize: 12,
    color: "#8A8A8E",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 16,
    marginBottom: 2,
  },
  card: { backgroundColor: "#1A1A1D", borderRadius: 14, paddingHorizontal: 16 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 14 },
  selectRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 14,
  },
  rowLabel: { fontSize: 14, color: "#8A8A8E" },
  rowValue: { fontSize: 15, color: "#F5F1E8", flexShrink: 1, textAlign: "right" },
  rowRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  tierText: { fontSize: 14, color: "#C9A227", fontWeight: "600", textTransform: "capitalize" },
  divider: { height: 1, backgroundColor: "#2A2A2C" },
  privacyBody: { fontSize: 13, color: "#C9C9CC", lineHeight: 19, paddingBottom: 14 },
  logoutButton: {
    marginTop: 28,
    paddingVertical: 14,
    alignItems: "center",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#E5484D",
  },
  logoutText: { color: "#E5484D", fontWeight: "700", fontSize: 15 },
});

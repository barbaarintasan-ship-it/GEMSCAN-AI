// Shown when a free member runs out of scans (or hits a premium gate
// mid-scan): a friendly card that explains the benefit and links out to the
// website to subscribe. Purchasing happens on the website only — never in-app.
//
// The free tier is now a LIFETIME allowance (standardScanLimitPeriod:
// "lifetime", standardScanDailyLimit: 10 in
// supabase/functions/_shared/entitlements.ts) — it never resets, so the copy
// must NOT say "come back tomorrow". Paid tiers keep a daily abuse cap. The
// caller passes the period so the message matches what the server enforces;
// with no period given we default to the free lifetime wording.
import React from "react";
import { View, Text, Pressable, Linking, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { PAYMENT_URL, EXTERNAL_PURCHASES_ENABLED } from "../lib/appLinks";

export function UpgradePrompt({ period = "lifetime" }: { period?: "day" | "lifetime" }) {
  const { i18n } = useTranslation();
  const so = i18n.language === "so";
  const lifetime = period === "lifetime";

  const title = lifetime
    ? (so ? "Waxaad isticmaashay dhammaan scan-nadaadii bilaashka ahaa" : "You've used all your free scans")
    : (so ? "Waxaad isticmaashay scan-nadii maanta" : "You've used today's free scans");
  const bodyNoCta = lifetime
    ? (so
      ? "Isticmaalayaasha bilaashka ah waxay helaan tiro xaddidan oo scan ah nolol-dhan; ma dib-u-cusboonaysiiyaan."
      : "Free users get a limited number of lifetime scans, which don't reset.")
    : (so
      ? "Isticmaalayaasha bilaashka ah waxay helaan tiro scan ah maalintii. Soo noqo berri si aad u sii wadato."
      : "Free users get a set number of standard scans per day. Come back tomorrow to continue.");
  const bodyCta = lifetime
    ? (so
      ? "Kor u qaad si aad u hesho scan dheeraad ah, Deep Scan qoto-dheer, iyo qiimayn suuq."
      : "Upgrade for more scans, Deep Scan analysis, and market-value reports.")
    : (so
      ? "Kor u qaad si aad u hesho scan dheeraad ah maalintii, Deep Scan qoto-dheer, iyo qiimayn suuq."
      : "Upgrade for more scans per day, Deep Scan analysis, and market-value reports.");

  // On iOS we cannot promote or link to the external website checkout (App
  // Store Guideline 3.1.1), so the limit message stands on its own with no
  // purchase call-to-action.
  if (!EXTERNAL_PURCHASES_ENABLED) {
    return (
      <View style={styles.card}>
        <Ionicons name="diamond" size={30} color="#C9A227" />
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.body}>{bodyNoCta}</Text>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <Ionicons name="diamond" size={30} color="#C9A227" />
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.body}>{bodyCta}</Text>
      <Pressable style={styles.button} onPress={() => Linking.openURL(PAYMENT_URL)}>
        <Ionicons name="sparkles-outline" size={18} color="#0B0B0C" />
        <Text style={styles.buttonText}>{so ? "Fur adeegga website-ka" : "Unlock on the website"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "rgba(201,162,39,0.12)",
    borderWidth: 1,
    borderColor: "#C9A227",
    borderRadius: 16,
    padding: 18,
    alignItems: "center",
    gap: 8,
    marginTop: 8,
  },
  title: { color: "#F5F1E8", fontWeight: "800", fontSize: 16, textAlign: "center" },
  body: { color: "#C9C9CC", fontSize: 13, textAlign: "center", lineHeight: 19 },
  button: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#C9A227",
    borderRadius: 999,
    paddingVertical: 12,
    paddingHorizontal: 24,
    marginTop: 6,
  },
  buttonText: { color: "#0B0B0C", fontWeight: "800", fontSize: 15 },
});

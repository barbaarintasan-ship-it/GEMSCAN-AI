// Shown when a free member runs out of today's 3 free scans (or hits a
// premium gate mid-scan): a friendly card that explains the benefit and links
// out to the website to subscribe. Purchasing happens on the website only —
// never in-app. The limit is a DAILY allowance — standardScanDailyLimit: 3 in
// supabase/functions/_shared/entitlements.ts, enforced against a UTC-midnight
// window in orchestrate-scan — so it is true and correct to tell the member
// to come back tomorrow.
import React from "react";
import { View, Text, Pressable, Linking, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { PAYMENT_URL, EXTERNAL_PURCHASES_ENABLED } from "../lib/appLinks";

export function UpgradePrompt() {
  const { i18n } = useTranslation();
  const so = i18n.language === "so";

  // On iOS we cannot promote or link to the external website checkout (App
  // Store Guideline 3.1.1), so the limit message stands on its own with no
  // purchase call-to-action.
  if (!EXTERNAL_PURCHASES_ENABLED) {
    return (
      <View style={styles.card}>
        <Ionicons name="diamond" size={30} color="#C9A227" />
        <Text style={styles.title}>
          {so ? "Waxaad isticmaashay 3-da scan ee maanta bilaashka ah" : "You've used today's 3 free scans"}
        </Text>
        <Text style={styles.body}>
          {so
            ? "Isticmaalayaasha bilaashka ah waxay helaan 3 scan maalin kasta. Soo noqo berri si aad u sii wadato."
            : "Free users get 3 standard scans per day. Come back tomorrow to continue."}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <Ionicons name="diamond" size={30} color="#C9A227" />
      <Text style={styles.title}>
        {so ? "Waxaad isticmaashay 3-da scan ee maanta bilaashka ah" : "You've used today's 3 free scans"}
      </Text>
      <Text style={styles.body}>
        {so
          ? "Isticmaalayaasha bilaashka ah waxay helaan 3 scan maalin kasta. Kor u qaad si aad u hesho scan dheeraad ah maalintii, Deep Scan qoto-dheer, iyo qiimayn suuq."
          : "Free users get 3 standard scans per day. Upgrade for more scans per day, Deep Scan analysis, and market-value reports."}
      </Text>
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

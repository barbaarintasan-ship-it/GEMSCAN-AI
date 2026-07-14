// Shown when a free member runs out of scans (or hits a premium gate mid-scan):
// a friendly card that explains the benefit and links out to the website to
// subscribe. Purchasing happens on the website only — never in-app.
import React from "react";
import { View, Text, Pressable, Linking, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { PAYMENT_URL } from "../lib/appLinks";

export function UpgradePrompt() {
  const { i18n } = useTranslation();
  const so = i18n.language === "so";
  return (
    <View style={styles.card}>
      <Ionicons name="diamond" size={30} color="#C9A227" />
      <Text style={styles.title}>
        {so ? "Waxaad dhammaysay scan-yadaada bilaashka ah maanta" : "You've used your free scans for today"}
      </Text>
      <Text style={styles.body}>
        {so
          ? "Kor u qaad si aad u hesho scan aan xad lahayn, Deep Scan qoto-dheer, iyo qiimayn suuq."
          : "Upgrade for unlimited scans, deeper analysis and market-value reports."}
      </Text>
      <Pressable style={styles.button} onPress={() => Linking.openURL(PAYMENT_URL)}>
        <Ionicons name="sparkles-outline" size={18} color="#0B0B0C" />
        <Text style={styles.buttonText}>{so ? "Arag qorshayaasha" : "View plans & subscribe"}</Text>
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

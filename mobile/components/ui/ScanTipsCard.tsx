// Pre-scan guidance — replaces long paragraphs with a quick icon checklist,
// shown before capture/upload/batch. Purely presentational; changes nothing
// about how a scan is captured or processed.
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, spacing, radius, type as t } from "../../lib/theme";

const TIPS: { icon: keyof typeof Ionicons.glyphMap; en: string; so: string }[] = [
  { icon: "cube-outline", en: "One object only", so: "Hal shay oo keliya" },
  { icon: "sunny-outline", en: "Good lighting", so: "Iftiin fiican" },
  { icon: "locate-outline", en: "Keep it centered", so: "Dhexda ku hay" },
  { icon: "aperture-outline", en: "Avoid blur", so: "Ka fogow madmadow" },
  { icon: "hand-left-outline", en: "Hold steady", so: "Si adag u hay" },
];

export function ScanTipsCard() {
  const { i18n } = useTranslation();
  const so = i18n.language === "so";
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{so ? "Ka hor scan-ka" : "Before you scan"}</Text>
      <View style={styles.grid}>
        {TIPS.map((tip) => (
          <View key={tip.en} style={styles.tip}>
            <View style={styles.iconCircle}>
              <Ionicons name={tip.icon} size={15} color={colors.gold} />
            </View>
            <Text style={styles.tipLabel} numberOfLines={2}>
              {so ? tip.so : tip.en}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    gap: spacing.md,
  },
  title: { ...t.label, marginTop: 0, marginBottom: 0 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md },
  tip: { flexDirection: "row", alignItems: "center", gap: spacing.sm, width: "46%" },
  iconCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.goldSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  tipLabel: { ...t.bodySmall, flexShrink: 1 },
});
